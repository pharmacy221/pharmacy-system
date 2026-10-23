-- ============================================================================
-- db/migration_009_item_discount.sql
-- خصم لكل صنف في الطلبية (بالإضافة لخصم الطلبية كلها):
--   * purchase_invoice_items.discount_percent : نسبة خصم الصنف (بتتطبق الأول، وبعدها خصم الطلبية)
--   * create_purchase_invoice(...) : بتقرا discount_percent من كل بند (اختياري، الافتراضي 0). نفس التوقيع بتاع migration_008.
-- لازم migration_008 تكون متطبقة قبلها. آمن لإعادة التشغيل، والبيانات القديمة خصمها 0.
-- ============================================================================
BEGIN;

ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoice_items_discount_percent_check') THEN
    ALTER TABLE purchase_invoice_items ADD CONSTRAINT purchase_invoice_items_discount_percent_check CHECK (discount_percent >= 0 AND discount_percent <= 100);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION create_purchase_invoice(
  p_supplier_id INTEGER, p_invoice_number TEXT, p_invoice_date DATE, p_due_date DATE, p_notes TEXT,
  p_user_id INTEGER, p_username TEXT, p_items JSONB, p_paid NUMERIC DEFAULT 0, p_method TEXT DEFAULT 'cash',
  p_idempotency_key TEXT DEFAULT NULL, p_discount_percent NUMERIC DEFAULT 0
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_inv purchase_invoices;
  v_item JSONB;
  v_med medicines;
  v_unit TEXT;
  v_qty INTEGER;
  v_cost NUMERIC;
  v_factor INTEGER;
  v_units INTEGER;
  v_unit_cost NUMERIC;
  v_idisc NUMERIC;
  v_expiry DATE;
  v_line NUMERIC;
  v_total NUMERIC := 0;
  v_subtotal NUMERIC := 0;
  v_disc NUMERIC := COALESCE(p_discount_percent, 0);
  v_batch_id INTEGER;
  v_bnum TEXT;
  v_count INTEGER := 0;
  v_today DATE := pharmacy_today();
BEGIN
  IF p_idempotency_key IS NOT NULL AND EXISTS (SELECT 1 FROM purchase_invoices WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'فاتورة الشراء اتسجلت قبل كده' USING ERRCODE = 'PH003';
  END IF;
  IF v_disc < 0 OR v_disc > 100 THEN
    RAISE EXCEPTION 'نسبة الخصم لازم تكون بين 0 و 100' USING ERRCODE = 'PH001';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'لازم تضيف صنف واحد على الأقل في الفاتورة' USING ERRCODE = 'PH001';
  END IF;
  IF jsonb_array_length(p_items) > 300 THEN
    RAISE EXCEPTION 'عدد البنود كبير جدًا في فاتورة واحدة' USING ERRCODE = 'PH001';
  END IF;
  IF p_invoice_date IS NULL THEN p_invoice_date := v_today; END IF;
  IF p_invoice_date > v_today + 1 THEN
    RAISE EXCEPTION 'تاريخ الفاتورة في المستقبل' USING ERRCODE = 'PH001';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_invoice_date THEN
    RAISE EXCEPTION 'تاريخ الاستحقاق قبل تاريخ الفاتورة' USING ERRCODE = 'PH001';
  END IF;
  IF COALESCE(p_paid, 0) < 0 THEN
    RAISE EXCEPTION 'المبلغ المدفوع لا يمكن أن يكون سالبًا' USING ERRCODE = 'PH001';
  END IF;
  IF p_method NOT IN ('cash', 'bank', 'other') THEN
    RAISE EXCEPTION 'طريقة الدفع غير صحيحة' USING ERRCODE = 'PH001';
  END IF;
  PERFORM 1 FROM suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود' USING ERRCODE = 'PH002'; END IF;

  p_invoice_number := NULLIF(btrim(COALESCE(p_invoice_number, '')), '');
  IF p_invoice_number IS NOT NULL AND EXISTS (
    SELECT 1 FROM purchase_invoices
    WHERE supplier_id = p_supplier_id AND lower(invoice_number) = lower(p_invoice_number) AND status = 'received'
  ) THEN
    RAISE EXCEPTION 'رقم الفاتورة ده متسجل قبل كده لنفس المورد' USING ERRCODE = 'PH003';
  END IF;

  INSERT INTO purchase_invoices (supplier_id, invoice_number, invoice_date, due_date, notes, idempotency_key, created_by, discount_percent)
  VALUES (p_supplier_id, p_invoice_number, p_invoice_date, p_due_date, NULLIF(btrim(COALESCE(p_notes, '')), ''), p_idempotency_key, p_user_id, v_disc)
  RETURNING * INTO v_inv;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_count := v_count + 1;
    BEGIN
      v_unit := COALESCE(v_item->>'unit', 'unit');
      v_qty := (v_item->>'quantity')::INTEGER;
      v_cost := (v_item->>'cost')::NUMERIC;
      v_expiry := (v_item->>'expiry_date')::DATE;
      v_idisc := COALESCE(NULLIF(v_item->>'discount_percent', '')::NUMERIC, 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'البند رقم %: بيانات غير صحيحة (الكمية/السعر/التاريخ)', v_count USING ERRCODE = 'PH001';
    END;

    SELECT * INTO v_med FROM medicines WHERE id = (v_item->>'medicine_id')::INTEGER AND is_active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'البند رقم %: الصنف غير موجود أو غير مفعّل', v_count USING ERRCODE = 'PH002'; END IF;
    IF v_unit NOT IN ('unit', 'strip', 'box') THEN
      RAISE EXCEPTION 'البند رقم % (%): وحدة غير صحيحة', v_count, v_med.name USING ERRCODE = 'PH001';
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty > 1000000 THEN
      RAISE EXCEPTION 'البند رقم % (%): الكمية لازم تكون رقم صحيح أكبر من صفر', v_count, v_med.name USING ERRCODE = 'PH001';
    END IF;
    IF v_cost IS NULL OR v_cost < 0 OR v_cost > 100000000 THEN
      RAISE EXCEPTION 'البند رقم % (%): السعر غير صحيح', v_count, v_med.name USING ERRCODE = 'PH001';
    END IF;
    IF v_idisc < 0 OR v_idisc > 100 THEN
      RAISE EXCEPTION 'البند رقم % (%): نسبة خصم الصنف لازم تكون بين 0 و 100', v_count, v_med.name USING ERRCODE = 'PH001';
    END IF;
    IF v_expiry IS NULL OR v_expiry < v_today THEN
      RAISE EXCEPTION 'البند رقم % (%): تاريخ الصلاحية مفقود أو منتهي', v_count, v_med.name USING ERRCODE = 'PH001';
    END IF;

    v_factor := CASE v_unit
      WHEN 'unit'  THEN 1
      WHEN 'strip' THEN COALESCE(v_med.units_per_strip, 1)
      ELSE COALESCE(v_med.units_per_strip, 1) * COALESCE(v_med.strips_per_box, 1)
    END;
    v_units := v_qty * v_factor;
    -- الخصم بيتطبق على كل البنود: تكلفة الحبة الفعلية = (سعر الوحدة بعد الخصم) / عدد الحبات
    -- خصم الصنف الأول، وبعده خصم الطلبية كلها
    v_unit_cost := ROUND(v_cost * (1 - v_idisc / 100) * (1 - v_disc / 100) / v_factor, 4);
    v_subtotal := v_subtotal + ROUND(v_qty * v_cost, 2);
    v_line := ROUND(v_qty * v_cost * (1 - v_idisc / 100) * (1 - v_disc / 100), 2);
    v_total := v_total + v_line;
    v_bnum := NULLIF(btrim(COALESCE(v_item->>'batch_number', '')), '');

    -- التشغيلة: trigger التشغيلات هو اللي بيزوّد المخزون ويحدّث متوسط التكلفة ويسجل حركة 'purchase'
    INSERT INTO batches (medicine_id, supplier_id, batch_number, expiry_date, received_units, quantity_units,
                         cost_price_unit, purchase_invoice_id)
    VALUES (v_med.id, p_supplier_id, v_bnum, v_expiry, v_units, v_units, v_unit_cost, v_inv.id)
    RETURNING id INTO v_batch_id;

    INSERT INTO purchase_invoice_items (invoice_id, medicine_id, batch_id, batch_number, expiry_date,
                                        entry_unit, entry_quantity, entry_cost, quantity_units, cost_price_unit, line_total, discount_percent)
    VALUES (v_inv.id, v_med.id, v_batch_id, v_bnum, v_expiry, v_unit, v_qty, v_cost, v_units, v_unit_cost, v_line, v_idisc);
  END LOOP;

  IF COALESCE(p_paid, 0) > v_total THEN
    RAISE EXCEPTION 'المدفوع (%) أكبر من إجمالي الفاتورة (%)', p_paid, v_total USING ERRCODE = 'PH001';
  END IF;

  UPDATE purchase_invoices SET total_amount = v_total, subtotal_amount = v_subtotal WHERE id = v_inv.id RETURNING * INTO v_inv;

  IF COALESCE(p_paid, 0) > 0 THEN
    PERFORM _apply_supplier_payment(v_inv, ROUND(p_paid, 2), p_method, 'دفعة وقت الاستلام', p_user_id);
  END IF;

  PERFORM audit_event(p_user_id, p_username, 'تسجيل فاتورة شراء', 'purchase_invoice', v_inv.id::text,
    jsonb_build_object('supplier_id', p_supplier_id, 'invoice_number', p_invoice_number, 'total', v_total,
                       'paid', COALESCE(p_paid, 0), 'items', v_count, 'discount_percent', v_disc));
  RETURN v_inv.id;
END $$;

COMMIT;
