-- ============================================================================
-- db/migration_005_rollback.sql  (ملف مولَّد)
-- يرجّع دوال الفاتورة/الإلغاء/المرتجع لتعريفاتها في migration_002 ويشيل دوال وجداول migration_005.
--
-- مهم:
--  * قبل التراجع لازم يكون مفيش فواتير آجلة غير مسددة: الدوال القديمة مبتعرفش الآجل (الخزنة هتتحسب غلط).
--    لو فيه، ادّي العملاء يسدّدوا الأول أو سجّل تسوية. الملف بيرفض التراجع لو فيه مديونية مفتوحة.
--  * الجداول (customers, customer_ledger, controlled_dispensing, stocktakes...) بتفضل كما هي
--    عشان مفيش بيانات تتحذف؛ احذفها يدويًا لو عايز بعد المراجعة.
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE balance <> 0) THEN
    RAISE EXCEPTION 'مينفعش التراجع: فيه عملاء رصيدهم مش صفر. سدّد/سوّي الأرصدة الأول.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS apply_stocktake(INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS start_stocktake(TEXT, TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS adjust_customer_balance(INTEGER, NUMERIC, TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS record_customer_payment(INTEGER, NUMERIC, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP TRIGGER IF EXISTS trg_guard_customer_balance ON customers;
DROP TRIGGER IF EXISTS trg_protect_customer_ledger ON customer_ledger;
DROP TRIGGER IF EXISTS trg_protect_controlled ON controlled_dispensing;

DROP FUNCTION IF EXISTS finalize_sale_invoice(INTEGER, NUMERIC, INTEGER, NUMERIC);

CREATE OR REPLACE FUNCTION finalize_sale_invoice(p_invoice_id INTEGER, p_discount NUMERIC, p_user_id INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  inv sale_invoices%ROWTYPE;
  v_subtotal NUMERIC;
  v_discount NUMERIC;
  v_total NUMERIC;
BEGIN
  SELECT * INTO inv FROM sale_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الفاتورة غير موجودة' USING ERRCODE = 'PH002';
  END IF;
  IF inv.status <> 'completed' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة' USING ERRCODE = 'PH001';
  END IF;
  IF inv.shift_id IS NULL THEN
    RAISE EXCEPTION 'الفاتورة لازم تكون مرتبطة بوردية' USING ERRCODE = 'PH001';
  END IF;
  IF EXISTS (SELECT 1 FROM cash_movements WHERE invoice_id = p_invoice_id AND movement_type = 'sale') THEN
    RAISE EXCEPTION 'الفاتورة اتسجلت قبل كده' USING ERRCODE = 'PH003';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_subtotal FROM sale_items WHERE invoice_id = p_invoice_id;
  IF v_subtotal <= 0 THEN
    RAISE EXCEPTION 'الفاتورة فارغة' USING ERRCODE = 'PH001';
  END IF;

  v_discount := ROUND(LEAST(GREATEST(COALESCE(p_discount, 0), 0), v_subtotal), 2);
  v_total := v_subtotal - v_discount;

  UPDATE sale_invoices SET discount = v_discount, total = v_total WHERE id = p_invoice_id;

  IF v_total > 0 THEN
    INSERT INTO cash_movements (shift_id, invoice_id, movement_type, method, amount, created_by)
    VALUES (inv.shift_id, p_invoice_id, 'sale', inv.payment_method, v_total, p_user_id);
  END IF;
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION void_sale_invoice(
  p_invoice_id INTEGER, p_user_id INTEGER, p_username TEXT, p_reason TEXT,
  p_refund_method TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  inv sale_invoices%ROWTYPE;
  v_today DATE := pharmacy_today();
  v_restored INTEGER := 0;
  v_expired INTEGER := 0;
  v_unbatched INTEGER := 0;
  v_remaining INTEGER;
  v_due NUMERIC;
  v_method TEXT;
  v_shift INTEGER;
  v_batch INTEGER;
  a RECORD;
  it RECORD;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'سبب الإلغاء مطلوب' USING ERRCODE = 'PH001';
  END IF;

  SELECT * INTO inv FROM sale_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الفاتورة غير موجودة' USING ERRCODE = 'PH002';
  END IF;
  IF inv.status = 'voided' THEN
    RAISE EXCEPTION 'الفاتورة دي ملغاة بالفعل' USING ERRCODE = 'PH003';
  END IF;

  -- ترتيب الأقفال: الفاتورة ← الأصناف (بترتيب الرقم) ← التشغيلات (نفس ترتيب البيع، بدون deadlock)
  PERFORM 1 FROM medicines
  WHERE id IN (SELECT medicine_id FROM sale_items WHERE invoice_id = p_invoice_id AND medicine_id IS NOT NULL)
  ORDER BY id FOR UPDATE;

  -- (أ) بنود ليها تسجيل تشغيلات: نرجّع المتبقي (المباع − اللي اتعكس بمرتجع) لنفس التشغيلة
  FOR a IN
    SELECT sib.id, sib.batch_id, sib.quantity_units - sib.reversed_units AS remaining,
           b.medicine_id, b.expiry_date
    FROM sale_item_batches sib
    JOIN sale_items si ON si.id = sib.sale_item_id
    JOIN batches b ON b.id = sib.batch_id
    WHERE si.invoice_id = p_invoice_id AND sib.quantity_units > sib.reversed_units
    ORDER BY sib.id
    FOR UPDATE OF sib, b
  LOOP
    UPDATE sale_item_batches SET reversed_units = quantity_units WHERE id = a.id;
    IF a.expiry_date >= v_today THEN
      UPDATE batches SET quantity_units = quantity_units + a.remaining WHERE id = a.batch_id;
      INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id, user_id, note)
      VALUES (a.medicine_id, a.batch_id, 'sale_void', a.remaining, 'sale_invoice', p_invoice_id, p_user_id, btrim(p_reason));
      v_restored := v_restored + a.remaining;
    ELSE
      v_expired := v_expired + a.remaining;      -- تشغيلة انتهت: متترجعش للمخزون الصالح
    END IF;
  END LOOP;

  -- (ب) بنود قديمة (قبل التحديث) من غير تسجيل تشغيلات: السلوك القديم، أحدث تشغيلة صالحة
  FOR it IN
    SELECT si.id, si.medicine_id,
           si.quantity_units - COALESCE((SELECT SUM(r.quantity_units) FROM returns r WHERE r.sale_item_id = si.id), 0) AS remaining
    FROM sale_items si
    WHERE si.invoice_id = p_invoice_id
      AND NOT EXISTS (SELECT 1 FROM sale_item_batches x WHERE x.sale_item_id = si.id)
    ORDER BY si.id
  LOOP
    v_remaining := it.remaining;
    CONTINUE WHEN v_remaining <= 0 OR it.medicine_id IS NULL;
    SELECT id INTO v_batch FROM batches
    WHERE medicine_id = it.medicine_id AND expiry_date >= v_today
    ORDER BY expiry_date DESC, id DESC LIMIT 1 FOR UPDATE;
    IF v_batch IS NULL THEN
      v_unbatched := v_unbatched + v_remaining;  -- مفيش تشغيلة صالحة نرجّع عليها
    ELSE
      UPDATE batches SET quantity_units = quantity_units + v_remaining WHERE id = v_batch;
      INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id, user_id, note)
      VALUES (it.medicine_id, v_batch, 'sale_void', v_remaining, 'sale_invoice', p_invoice_id, p_user_id, btrim(p_reason));
      v_restored := v_restored + v_remaining;
    END IF;
  END LOOP;

  -- (ج) الجانب المالي: المبلغ اللي لسه للعميل = إجمالي الفاتورة − اللي اترد قبل كده بمرتجعات
  SELECT GREATEST(inv.total - COALESCE(SUM(refund_amount), 0), 0) INTO v_due
  FROM returns WHERE invoice_id = p_invoice_id;

  v_method := COALESCE(NULLIF(p_refund_method, ''), inv.payment_method);
  IF v_method NOT IN ('cash', 'card', 'other', 'none') THEN
    RAISE EXCEPTION 'طريقة رد المبلغ غير صحيحة' USING ERRCODE = 'PH001';
  END IF;

  IF v_due > 0 AND v_method <> 'none' THEN
    SELECT id INTO v_shift FROM shifts WHERE opened_by = p_user_id AND closed_at IS NULL;
    IF v_method = 'cash' AND v_shift IS NULL THEN
      RAISE EXCEPTION 'لازم تفتح وردية عشان تسجّل رد النقدية قبل إلغاء الفاتورة' USING ERRCODE = 'PH001';
    END IF;
    INSERT INTO cash_movements (shift_id, invoice_id, movement_type, method, amount, note, created_by)
    VALUES (v_shift, p_invoice_id, 'void_refund', v_method, -v_due, btrim(p_reason), p_user_id);
  END IF;

  UPDATE sale_invoices
  SET status = 'voided', voided_at = now(), voided_by = p_user_id, void_reason = btrim(p_reason)
  WHERE id = p_invoice_id;

  PERFORM audit_event(p_user_id, p_username, 'إلغاء فاتورة بيع', 'sale_invoice', p_invoice_id::text,
    jsonb_build_object('reason', btrim(p_reason), 'total', inv.total, 'refund_due', v_due,
                       'refund_method', v_method, 'restored_units', v_restored,
                       'expired_units_not_restocked', v_expired, 'unbatched_units_not_restocked', v_unbatched));

  RETURN jsonb_build_object('invoice_id', p_invoice_id, 'restored_units', v_restored,
                            'expired_units', v_expired, 'unbatched_units', v_unbatched,
                            'refund_due', v_due, 'refund_method', v_method);
END;
$$;

CREATE OR REPLACE FUNCTION create_return(
  p_sale_item_id INTEGER, p_quantity INTEGER, p_reason TEXT, p_restock BOOLEAN,
  p_refund_method TEXT, p_user_id INTEGER, p_username TEXT, p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  it sale_items%ROWTYPE;
  inv sale_invoices%ROWTYPE;
  v_today DATE := pharmacy_today();
  v_dup JSONB;
  v_prior_qty INTEGER;
  v_prior_refund NUMERIC;
  v_inv_refunds NUMERIC;
  v_items_total NUMERIC;
  v_item_net NUMERIC;
  v_refund NUMERIC;
  v_units INTEGER;
  v_left INTEGER;
  v_take INTEGER;
  v_remaining_qty INTEGER;
  v_method TEXT;
  v_shift INTEGER;
  v_rid INTEGER;
  v_restocked INTEGER := 0;
  v_cost_rec NUMERIC := 0;
  v_batch INTEGER;
  a RECORD;
BEGIN
  SELECT * INTO it FROM sale_items WHERE id = p_sale_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'بند الفاتورة غير موجود' USING ERRCODE = 'PH002';
  END IF;

  -- قفل الفاتورة: بيسلسل المرتجعات والإلغاء على نفس الفاتورة
  SELECT * INTO inv FROM sale_invoices WHERE id = it.invoice_id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT jsonb_build_object('return_id', id, 'refund_amount', refund_amount, 'duplicate', true)
    INTO v_dup FROM returns WHERE idempotency_key = p_idempotency_key;
    IF v_dup IS NOT NULL THEN RETURN v_dup; END IF;
  END IF;

  IF inv.status <> 'completed' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة ومينفعش عليها مرتجع' USING ERRCODE = 'PH001';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'الكمية لازم تكون 1 أو أكتر' USING ERRCODE = 'PH001';
  END IF;

  IF it.medicine_id IS NOT NULL THEN
    PERFORM 1 FROM medicines WHERE id = it.medicine_id FOR UPDATE;
  END IF;

  SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(refund_amount), 0)
  INTO v_prior_qty, v_prior_refund FROM returns WHERE sale_item_id = it.id;

  v_remaining_qty := it.quantity - v_prior_qty;
  IF p_quantity > v_remaining_qty THEN
    RAISE EXCEPTION 'الكمية المرتجعة أكبر من المتاح للإرجاع (المتبقي: %)', GREATEST(v_remaining_qty, 0)
      USING ERRCODE = 'PH001';
  END IF;

  -- المبلغ المسترد = سعر البند بعد نصيبه من خصم الفاتورة، متناسب مع الكمية.
  -- آخر مرتجع على البند بياخد الباقي بالظبط عشان الكسور متتراكمش.
  SELECT COALESCE(SUM(total), 0) INTO v_items_total FROM sale_items WHERE invoice_id = inv.id;
  v_item_net := ROUND(it.total * CASE WHEN v_items_total > 0 THEN inv.total / v_items_total ELSE 1 END, 2);
  IF p_quantity = v_remaining_qty THEN
    v_refund := v_item_net - v_prior_refund;
  ELSE
    v_refund := ROUND(v_item_net * p_quantity / it.quantity, 2);
  END IF;
  SELECT COALESCE(SUM(refund_amount), 0) INTO v_inv_refunds FROM returns WHERE invoice_id = inv.id;
  v_refund := GREATEST(LEAST(v_refund, inv.total - v_inv_refunds), 0);

  v_units := (it.quantity_units / it.quantity) * p_quantity;

  v_method := COALESCE(NULLIF(p_refund_method, ''), inv.payment_method);
  IF v_method NOT IN ('cash', 'card', 'other', 'none') THEN
    RAISE EXCEPTION 'طريقة رد المبلغ غير صحيحة' USING ERRCODE = 'PH001';
  END IF;
  IF v_refund > 0 AND v_method <> 'none' THEN
    SELECT id INTO v_shift FROM shifts WHERE opened_by = p_user_id AND closed_at IS NULL;
    IF v_method = 'cash' AND v_shift IS NULL THEN
      RAISE EXCEPTION 'لازم تفتح وردية عشان تسجّل رد النقدية' USING ERRCODE = 'PH001';
    END IF;
  END IF;

  v_rid := nextval(pg_get_serial_sequence('returns', 'id'));

  -- نوزّع الكمية المرتجعة على التشغيلات اللي اتباع منها (الصالحة الأول).
  -- بنرجّع للمخزون بس لو العميل/الصيدلي حدد "رجّع للمخزون" والتشغيلة لسه صالحة (مش منتهية).
  v_left := v_units;
  FOR a IN
    SELECT sib.id, sib.batch_id, sib.quantity_units - sib.reversed_units AS avail,
           sib.cost_price_unit, b.expiry_date
    FROM sale_item_batches sib
    JOIN batches b ON b.id = sib.batch_id
    WHERE sib.sale_item_id = it.id AND sib.quantity_units > sib.reversed_units
    ORDER BY (b.expiry_date >= v_today) DESC, b.expiry_date ASC, sib.id
    FOR UPDATE OF sib, b
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(a.avail, v_left);
    UPDATE sale_item_batches SET reversed_units = reversed_units + v_take WHERE id = a.id;
    IF p_restock AND a.expiry_date >= v_today THEN
      UPDATE batches SET quantity_units = quantity_units + v_take WHERE id = a.batch_id;
      INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id, user_id, note)
      VALUES (it.medicine_id, a.batch_id, 'return', v_take, 'return', v_rid, p_user_id, p_reason);
      v_restocked := v_restocked + v_take;
      v_cost_rec := v_cost_rec + (v_take * a.cost_price_unit);
    END IF;
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    IF EXISTS (SELECT 1 FROM sale_item_batches WHERE sale_item_id = it.id) THEN
      RAISE EXCEPTION 'تعارض بين الكمية المرتجعة وتشغيلات البيع' USING ERRCODE = 'PH001';
    END IF;
    -- بند قديم من غير تسجيل تشغيلات: أحدث تشغيلة صالحة (السلوك القديم)
    IF p_restock AND it.medicine_id IS NOT NULL THEN
      SELECT id INTO v_batch FROM batches
      WHERE medicine_id = it.medicine_id AND expiry_date >= v_today
      ORDER BY expiry_date DESC, id DESC LIMIT 1 FOR UPDATE;
      IF v_batch IS NOT NULL THEN
        UPDATE batches SET quantity_units = quantity_units + v_left WHERE id = v_batch;
        INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id, user_id, note)
        VALUES (it.medicine_id, v_batch, 'return', v_left, 'return', v_rid, p_user_id, p_reason);
        v_restocked := v_restocked + v_left;
        v_cost_rec := v_cost_rec + (v_left * COALESCE(it.cost_price_unit_snapshot, 0));
      END IF;
    END IF;
  END IF;

  INSERT INTO returns (id, invoice_id, sale_item_id, medicine_id, medicine_name_snapshot, sale_unit, unit_label,
                       quantity, quantity_units, refund_amount, refund_method, reason,
                       restocked, restocked_units, cost_recovered, created_by, idempotency_key)
  VALUES (v_rid, inv.id, it.id, it.medicine_id, it.medicine_name_snapshot, it.sale_unit, it.unit_label,
          p_quantity, v_units, v_refund, v_method, NULLIF(btrim(COALESCE(p_reason, '')), ''),
          v_restocked > 0, v_restocked, ROUND(v_cost_rec, 4), p_user_id, p_idempotency_key);

  IF v_refund > 0 AND v_method <> 'none' THEN
    INSERT INTO cash_movements (shift_id, invoice_id, return_id, movement_type, method, amount, note, created_by)
    VALUES (v_shift, inv.id, v_rid, 'refund', v_method, -v_refund, NULLIF(btrim(COALESCE(p_reason, '')), ''), p_user_id);
  END IF;

  PERFORM audit_event(p_user_id, p_username, 'تسجيل مرتجع', 'return', v_rid::text,
    jsonb_build_object('invoice_id', inv.id, 'medicine_name', it.medicine_name_snapshot, 'quantity', p_quantity,
                       'refund_amount', v_refund, 'refund_method', v_method, 'restocked_units', v_restocked,
                       'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')));

  RETURN jsonb_build_object('return_id', v_rid, 'refund_amount', v_refund, 'restocked_units', v_restocked,
                            'quantity_units', v_units, 'duplicate', false);
END;
$$;

COMMIT;
