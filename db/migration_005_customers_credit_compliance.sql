-- ============================================================================
-- db/migration_005_customers_credit_compliance.sql
-- (ملف مولَّد — المصدر: db/migration_005_*.part + تعريفات migration_002. التعديل يتم على الأجزاء ثم إعادة التوليد)
--
-- 1) ملف العملاء + دفتر حساب (بيع آجل / سداد / تسويات) + تذكيرات إعادة الصرف للمزمنين
-- 2) دعم البيع الآجل في إنهاء الفاتورة والإلغاء والمرتجعات (الجزء الآجل بيتخصم من مديونية العميل الأول)
-- 3) سجل صرف الأدوية الخاضعة للرقابة (غير قابل للتعديل أو الحذف)
-- 4) الجرد الدوري للمخزون (يطبّق الفروق عن طريق adjust_medicine_stock بنفس سجل التسويات)
--
-- شغّله بعد migration_004. idempotent. خد نسخة احتياطية قبل التشغيل على بيانات حقيقية.
-- التراجع: db/migration_005_rollback.sql
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- 1) العملاء
--    balance: المديونية الحالية للعميل (موجب = عليه فلوس للصيدلية، سالب = رصيد دائن له).
--    credit_limit = 0 يعني: البيع الآجل غير مسموح لهذا العميل.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- رقم التليفون فريد بعد تنظيفه من أي رموز (مسافات/شرطات/+)
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_phone
  ON customers ((regexp_replace(phone, '\D', '', 'g')))
  WHERE phone IS NOT NULL AND regexp_replace(phone, '\D', '', 'g') <> '';
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (lower(name));

DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- الفواتير: ربط بالعميل + الجزء الآجل + اللي اتلغى منه (بمرتجع أو إلغاء)
ALTER TABLE sale_invoices
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS credit_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_reversed NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sale_invoices DROP CONSTRAINT IF EXISTS chk_invoice_credit;
ALTER TABLE sale_invoices ADD CONSTRAINT chk_invoice_credit
  CHECK (credit_amount >= 0 AND credit_reversed >= 0 AND credit_reversed <= credit_amount);
CREATE INDEX IF NOT EXISTS idx_sale_invoices_customer ON sale_invoices (customer_id, created_at DESC);

ALTER TABLE returns ADD COLUMN IF NOT EXISTS credit_applied NUMERIC(12,2) NOT NULL DEFAULT 0;

-- دفتر حساب العميل: كل حركة على المديونية (موجب = بتزوّد المديونية، سالب = بتنقصها)
CREATE TABLE IF NOT EXISTS customer_ledger (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('credit_sale', 'payment', 'return_credit', 'void_credit', 'adjustment')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  balance_after NUMERIC(12,2) NOT NULL,
  invoice_id INTEGER REFERENCES sale_invoices(id) ON DELETE SET NULL,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  method TEXT,
  note TEXT,
  idempotency_key TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger (customer_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_ledger_idem ON customer_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- الدفتر للقراءة فقط: لا تعديل ولا حذف (التصحيح بقيد تسوية جديد)
CREATE OR REPLACE FUNCTION protect_customer_ledger() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'دفتر حساب العميل غير قابل للتعديل أو الحذف؛ سجّل قيد تسوية' USING ERRCODE = 'PH001';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_customer_ledger ON customer_ledger;
CREATE TRIGGER trg_protect_customer_ledger
BEFORE UPDATE OR DELETE ON customer_ledger
FOR EACH ROW EXECUTE FUNCTION protect_customer_ledger();

-- الرصيد لا يتغير إلا من customer_post (نفس فكرة حماية stock_units)
CREATE OR REPLACE FUNCTION guard_customer_balance() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance
     AND COALESCE(current_setting('app.customer_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'تعديل رصيد العميل مباشرة غير مسموح؛ استخدم سداد أو قيد تسوية' USING ERRCODE = 'PH001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_customer_balance ON customers;
CREATE TRIGGER trg_guard_customer_balance
BEFORE UPDATE OF balance ON customers
FOR EACH ROW EXECUTE FUNCTION guard_customer_balance();

-- ترحيل حركة على حساب العميل (بتقفل صف العميل). بترجّع الرصيد بعد الحركة.
CREATE OR REPLACE FUNCTION customer_post(
  p_customer_id INTEGER, p_type TEXT, p_amount NUMERIC, p_invoice_id INTEGER, p_shift_id INTEGER,
  p_method TEXT, p_note TEXT, p_user_id INTEGER, p_idem TEXT DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  SELECT balance INTO v_balance FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العميل غير موجود' USING ERRCODE = 'PH002';
  END IF;
  v_balance := v_balance + p_amount;
  PERFORM set_config('app.customer_write', 'on', true);
  UPDATE customers SET balance = v_balance WHERE id = p_customer_id;
  PERFORM set_config('app.customer_write', 'off', true);
  INSERT INTO customer_ledger (customer_id, entry_type, amount, balance_after, invoice_id, shift_id, method, note, idempotency_key, created_by)
  VALUES (p_customer_id, p_type, p_amount, v_balance, p_invoice_id, p_shift_id, p_method, NULLIF(btrim(COALESCE(p_note, '')), ''), p_idem, p_user_id);
  RETURN v_balance;
END;
$$;

-- سداد من العميل. النقدي بيدخل درج وردية الكاشير (إيداع) عشان العهدة تتزبط.
CREATE OR REPLACE FUNCTION record_customer_payment(
  p_customer_id INTEGER, p_amount NUMERIC, p_method TEXT, p_note TEXT,
  p_user_id INTEGER, p_username TEXT, p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  c customers%ROWTYPE;
  v_shift INTEGER;
  v_balance NUMERIC;
  v_dup JSONB;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT jsonb_build_object('ledger_id', id, 'balance', balance_after, 'duplicate', true)
    INTO v_dup FROM customer_ledger WHERE idempotency_key = p_idempotency_key;
    IF v_dup IS NOT NULL THEN RETURN v_dup; END IF;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'مبلغ السداد لازم يكون أكبر من صفر' USING ERRCODE = 'PH001';
  END IF;
  IF p_method NOT IN ('cash', 'card', 'other') THEN
    RAISE EXCEPTION 'طريقة السداد غير صحيحة' USING ERRCODE = 'PH001';
  END IF;

  SELECT * INTO c FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العميل غير موجود' USING ERRCODE = 'PH002';
  END IF;
  IF p_amount > c.balance THEN
    RAISE EXCEPTION 'مبلغ السداد (%) أكبر من المديونية الحالية (%)', p_amount, c.balance USING ERRCODE = 'PH001';
  END IF;

  SELECT id INTO v_shift FROM shifts WHERE opened_by = p_user_id AND closed_at IS NULL;
  IF p_method = 'cash' THEN
    IF v_shift IS NULL THEN
      RAISE EXCEPTION 'لازم تفتح وردية عشان تسجّل السداد النقدي في الدرج' USING ERRCODE = 'PH001';
    END IF;
    INSERT INTO cash_movements (shift_id, movement_type, method, amount, note, created_by)
    VALUES (v_shift, 'deposit', 'cash', p_amount, 'سداد عميل: ' || c.name, p_user_id);
  END IF;

  v_balance := customer_post(c.id, 'payment', -p_amount, NULL, v_shift, p_method, p_note, p_user_id, p_idempotency_key);

  PERFORM audit_event(p_user_id, p_username, 'سداد عميل', 'customer', c.id::text,
    jsonb_build_object('customer_name', c.name, 'total', p_amount, 'refund_method', p_method, 'balance_after', v_balance));

  RETURN jsonb_build_object('customer_id', c.id, 'balance', v_balance, 'duplicate', false);
END;
$$;

-- قيد تسوية يدوي (أدمن): رصيد افتتاحي للعملاء القدامى أو تصحيح. بدون أي أثر على الخزنة.
CREATE OR REPLACE FUNCTION adjust_customer_balance(
  p_customer_id INTEGER, p_delta NUMERIC, p_reason TEXT, p_user_id INTEGER, p_username TEXT
) RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  c customers%ROWTYPE;
  v_balance NUMERIC;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'مقدار التسوية لازم يكون مختلف عن صفر' USING ERRCODE = 'PH001';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'سبب التسوية مطلوب' USING ERRCODE = 'PH001';
  END IF;
  SELECT * INTO c FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'العميل غير موجود' USING ERRCODE = 'PH002';
  END IF;
  v_balance := customer_post(c.id, 'adjustment', p_delta, NULL, NULL, NULL, p_reason, p_user_id);
  PERFORM audit_event(p_user_id, p_username, 'تسوية رصيد عميل', 'customer', c.id::text,
    jsonb_build_object('customer_name', c.name, 'difference', p_delta, 'new_value', v_balance, 'reason', btrim(p_reason)));
  RETURN v_balance;
END;
$$;

-- تذكيرات إعادة الصرف (الأدوية المزمنة): كل CUSTOMER × صنف × كل كام يوم.
-- آخر صرف بيتحسب من الفواتير الفعلية (مفيش بيانات مكررة تتنسّى تتحدّث).
CREATE TABLE IF NOT EXISTS customer_refills (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 5 AND 365),
  start_date DATE NOT NULL DEFAULT pharmacy_today(),
  snoozed_until DATE,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (customer_id, medicine_id)
);

-- ----------------------------------------------------------------------------
-- 3) سجل صرف الأدوية الخاضعة للرقابة (مخدرات/منظّمة): بيانات المريض والروشتة لكل صرف.
--    غير قابل للتعديل أو الحذف. الفاتورة لو اتلغت بيفضل السجل وبيظهر عليه إنها ملغاة.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS controlled_dispensing (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES sale_invoices(id) ON DELETE RESTRICT,
  sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE RESTRICT,
  medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
  medicine_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_label TEXT,
  quantity_units INTEGER NOT NULL,
  patient_name TEXT NOT NULL,
  national_id TEXT NOT NULL,
  prescription_no TEXT NOT NULL,
  doctor_name TEXT,
  dispensed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_controlled_created ON controlled_dispensing (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_controlled_medicine ON controlled_dispensing (medicine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_controlled_invoice ON controlled_dispensing (invoice_id);

CREATE OR REPLACE FUNCTION protect_controlled_dispensing() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'سجل الأدوية الخاضعة للرقابة غير قابل للتعديل أو الحذف' USING ERRCODE = 'PH001';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_controlled ON controlled_dispensing;
CREATE TRIGGER trg_protect_controlled
BEFORE UPDATE OR DELETE ON controlled_dispensing
FOR EACH ROW EXECUTE FUNCTION protect_controlled_dispensing();

-- ----------------------------------------------------------------------------
-- 4) الجرد
--    system_units = لقطة المخزون وقت بداية الجرد (للمقارنة)، counted_units = العدّ الفعلي.
--    الاعتماد بيضبط المخزون على العدّ الفعلي (adjust_medicine_stock) لكل صنف اتعدّ واختلف.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stocktakes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'cancelled')),
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  applied_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS stocktake_items (
  id SERIAL PRIMARY KEY,
  stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  system_units INTEGER NOT NULL,
  cost_unit NUMERIC(12,4) NOT NULL DEFAULT 0,
  counted_units INTEGER CHECK (counted_units IS NULL OR counted_units >= 0),
  counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  counted_at TIMESTAMPTZ,
  applied_difference INTEGER,
  apply_status TEXT,
  UNIQUE (stocktake_id, medicine_id)
);
CREATE INDEX IF NOT EXISTS idx_stocktake_items_st ON stocktake_items (stocktake_id);

CREATE OR REPLACE FUNCTION start_stocktake(
  p_name TEXT, p_category TEXT, p_user_id INTEGER, p_username TEXT
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_id INTEGER;
  v_count INTEGER;
BEGIN
  INSERT INTO stocktakes (name, category, created_by)
  VALUES (COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), 'جرد ' || to_char(pharmacy_today(), 'YYYY-MM-DD')),
          NULLIF(btrim(COALESCE(p_category, '')), ''), p_user_id)
  RETURNING id INTO v_id;

  INSERT INTO stocktake_items (stocktake_id, medicine_id, system_units, cost_unit)
  SELECT v_id, m.id, m.stock_units, COALESCE(m.cost_price_unit, 0)
  FROM medicines m
  WHERE m.is_active = true
    AND (NULLIF(btrim(COALESCE(p_category, '')), '') IS NULL OR m.category = btrim(p_category));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'مفيش أصناف تدخل في الجرد بالاختيار ده' USING ERRCODE = 'PH001';
  END IF;

  PERFORM audit_event(p_user_id, p_username, 'بدء جرد', 'stocktake', v_id::text,
    jsonb_build_object('items_count', v_count, 'category', NULLIF(btrim(COALESCE(p_category, '')), '')));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION apply_stocktake(
  p_stocktake_id INTEGER, p_user_id INTEGER, p_username TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  st stocktakes%ROWTYPE;
  it RECORD;
  v_res JSONB;
  v_applied INTEGER := 0;
  v_same INTEGER := 0;
  v_failed INTEGER := 0;
  v_uncounted INTEGER := 0;
  v_gain NUMERIC := 0;
  v_loss NUMERIC := 0;
BEGIN
  SELECT * INTO st FROM stocktakes WHERE id = p_stocktake_id FOR UPDATE;   -- بيمنع الاعتماد المزدوج
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الجرد غير موجود' USING ERRCODE = 'PH002';
  END IF;
  IF st.status <> 'open' THEN
    RAISE EXCEPTION 'الجرد ده اتقفل بالفعل' USING ERRCODE = 'PH003';
  END IF;

  FOR it IN SELECT * FROM stocktake_items WHERE stocktake_id = st.id ORDER BY medicine_id LOOP
    IF it.counted_units IS NULL THEN
      v_uncounted := v_uncounted + 1;
      CONTINUE;
    END IF;
    BEGIN
      v_res := adjust_medicine_stock(it.medicine_id, it.counted_units, 'جرد #' || st.id || ' — ' || st.name, p_user_id, p_username);
      UPDATE stocktake_items
      SET applied_difference = (v_res->>'difference')::int,
          apply_status = CASE WHEN (v_res->>'difference')::int = 0 THEN 'same' ELSE 'applied' END
      WHERE id = it.id;
      IF (v_res->>'difference')::int = 0 THEN
        v_same := v_same + 1;
      ELSE
        v_applied := v_applied + 1;
        IF (v_res->>'difference')::int > 0 THEN
          v_gain := v_gain + (v_res->>'difference')::int * it.cost_unit;
        ELSE
          v_loss := v_loss + (-(v_res->>'difference')::int) * it.cost_unit;
        END IF;
      END IF;
    EXCEPTION WHEN SQLSTATE 'PH001' THEN
      -- مثال: زيادة من غير تشغيلة صالحة نضيف عليها. بنسجّل السبب وبنكمل باقي الأصناف.
      UPDATE stocktake_items SET apply_status = 'failed: ' || SQLERRM WHERE id = it.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  UPDATE stocktakes SET status = 'applied', applied_by = p_user_id, applied_at = now() WHERE id = st.id;

  PERFORM audit_event(p_user_id, p_username, 'اعتماد جرد', 'stocktake', st.id::text,
    jsonb_build_object('applied', v_applied, 'unchanged', v_same, 'failed', v_failed, 'uncounted', v_uncounted,
                       'gain_value', ROUND(v_gain, 2), 'loss_value', ROUND(v_loss, 2)));

  RETURN jsonb_build_object('applied', v_applied, 'unchanged', v_same, 'failed', v_failed, 'uncounted', v_uncounted,
                            'gain_value', ROUND(v_gain, 2), 'loss_value', ROUND(v_loss, 2));
END;
$$;

-- ----------------------------------------------------------------------------
-- دوال محدّثة (نفس منطق migration_002 + دعم الآجل). الفرق عن الأصل موضّح بالتعليقات العربية فيها.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS finalize_sale_invoice(INTEGER, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION finalize_sale_invoice(p_invoice_id INTEGER, p_discount NUMERIC, p_user_id INTEGER, p_credit NUMERIC DEFAULT 0)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  inv sale_invoices%ROWTYPE;
  v_subtotal NUMERIC;
  v_discount NUMERIC;
  v_total NUMERIC;
  v_credit NUMERIC := 0;
  v_cust customers%ROWTYPE;
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
  IF inv.credit_amount > 0 OR EXISTS (SELECT 1 FROM cash_movements WHERE invoice_id = p_invoice_id AND movement_type = 'sale') THEN
    RAISE EXCEPTION 'الفاتورة اتسجلت قبل كده' USING ERRCODE = 'PH003';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_subtotal FROM sale_items WHERE invoice_id = p_invoice_id;
  IF v_subtotal <= 0 THEN
    RAISE EXCEPTION 'الفاتورة فارغة' USING ERRCODE = 'PH001';
  END IF;

  v_discount := ROUND(LEAST(GREATEST(COALESCE(p_discount, 0), 0), v_subtotal), 2);
  v_total := v_subtotal - v_discount;

  UPDATE sale_invoices SET discount = v_discount, total = v_total WHERE id = p_invoice_id;

  -- البيع الآجل: الجزء غير المدفوع بيتسجل على حساب العميل (مش في الخزنة)
  v_credit := ROUND(LEAST(GREATEST(COALESCE(p_credit, 0), 0), v_total), 2);
  IF v_credit > 0 THEN
    IF inv.customer_id IS NULL THEN
      RAISE EXCEPTION 'البيع الآجل لازم يكون لعميل مسجّل' USING ERRCODE = 'PH001';
    END IF;
    SELECT * INTO v_cust FROM customers WHERE id = inv.customer_id FOR UPDATE;
    IF NOT FOUND OR NOT v_cust.is_active THEN
      RAISE EXCEPTION 'العميل غير موجود أو موقوف' USING ERRCODE = 'PH001';
    END IF;
    IF v_cust.balance + v_credit > v_cust.credit_limit THEN
      RAISE EXCEPTION 'تجاوز حد الآجل للعميل (الحد %، المديونية الحالية %، المطلوب تأجيله %)',
        v_cust.credit_limit, v_cust.balance, v_credit USING ERRCODE = 'PH001';
    END IF;
    PERFORM customer_post(inv.customer_id, 'credit_sale', v_credit, p_invoice_id, inv.shift_id, NULL, NULL, p_user_id);
    UPDATE sale_invoices SET credit_amount = v_credit WHERE id = p_invoice_id;
  END IF;

  IF v_total - v_credit > 0 THEN
    INSERT INTO cash_movements (shift_id, invoice_id, movement_type, method, amount, created_by)
    VALUES (inv.shift_id, p_invoice_id, 'sale', inv.payment_method, v_total - v_credit, p_user_id);
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
  v_credit_cancel NUMERIC := 0;
  v_due_cash NUMERIC := 0;
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

  -- الجزء الآجل اللي لسه على العميل بيتلغي من مديونيته الأول؛ الباقي بس هو اللي يترد نقدي
  v_credit_cancel := GREATEST(LEAST(v_due, inv.credit_amount - inv.credit_reversed), 0);
  v_due_cash := v_due - v_credit_cancel;

  v_method := COALESCE(NULLIF(p_refund_method, ''), inv.payment_method);
  IF v_method NOT IN ('cash', 'card', 'other', 'none') THEN
    RAISE EXCEPTION 'طريقة رد المبلغ غير صحيحة' USING ERRCODE = 'PH001';
  END IF;

  IF v_due_cash > 0 AND v_method <> 'none' THEN
    SELECT id INTO v_shift FROM shifts WHERE opened_by = p_user_id AND closed_at IS NULL;
    IF v_method = 'cash' AND v_shift IS NULL THEN
      RAISE EXCEPTION 'لازم تفتح وردية عشان تسجّل رد النقدية قبل إلغاء الفاتورة' USING ERRCODE = 'PH001';
    END IF;
    INSERT INTO cash_movements (shift_id, invoice_id, movement_type, method, amount, note, created_by)
    VALUES (v_shift, p_invoice_id, 'void_refund', v_method, -v_due_cash, btrim(p_reason), p_user_id);
  END IF;

  IF v_credit_cancel > 0 THEN
    PERFORM customer_post(inv.customer_id, 'void_credit', -v_credit_cancel, p_invoice_id, NULL, NULL, btrim(p_reason), p_user_id);
    UPDATE sale_invoices SET credit_reversed = credit_reversed + v_credit_cancel WHERE id = p_invoice_id;
  END IF;

  UPDATE sale_invoices
  SET status = 'voided', voided_at = now(), voided_by = p_user_id, void_reason = btrim(p_reason)
  WHERE id = p_invoice_id;

  PERFORM audit_event(p_user_id, p_username, 'إلغاء فاتورة بيع', 'sale_invoice', p_invoice_id::text,
    jsonb_build_object('reason', btrim(p_reason), 'total', inv.total, 'refund_due', v_due, 'credit_cancelled', v_credit_cancel,
                       'refund_method', v_method, 'restored_units', v_restored,
                       'expired_units_not_restocked', v_expired, 'unbatched_units_not_restocked', v_unbatched));

  RETURN jsonb_build_object('invoice_id', p_invoice_id, 'restored_units', v_restored,
                            'expired_units', v_expired, 'unbatched_units', v_unbatched,
                            'refund_due', v_due, 'refund_method', v_method,
                            'credit_cancelled', v_credit_cancel, 'cash_refund', v_due_cash);
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
  v_credit_part NUMERIC := 0;
  v_cash_refund NUMERIC := 0;
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
  -- لو الفاتورة فيها جزء آجل: المرتجع بيخصم من مديونية العميل الأول، والباقي بس يترد من الخزنة
  v_credit_part := GREATEST(LEAST(v_refund, inv.credit_amount - inv.credit_reversed), 0);
  v_cash_refund := v_refund - v_credit_part;

  v_units := (it.quantity_units / it.quantity) * p_quantity;

  v_method := COALESCE(NULLIF(p_refund_method, ''), inv.payment_method);
  IF v_method NOT IN ('cash', 'card', 'other', 'none') THEN
    RAISE EXCEPTION 'طريقة رد المبلغ غير صحيحة' USING ERRCODE = 'PH001';
  END IF;
  IF v_cash_refund > 0 AND v_method <> 'none' THEN
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
                       restocked, restocked_units, cost_recovered, created_by, idempotency_key, credit_applied)
  VALUES (v_rid, inv.id, it.id, it.medicine_id, it.medicine_name_snapshot, it.sale_unit, it.unit_label,
          p_quantity, v_units, v_refund, v_method, NULLIF(btrim(COALESCE(p_reason, '')), ''),
          v_restocked > 0, v_restocked, ROUND(v_cost_rec, 4), p_user_id, p_idempotency_key, v_credit_part);

  IF v_cash_refund > 0 AND v_method <> 'none' THEN
    INSERT INTO cash_movements (shift_id, invoice_id, return_id, movement_type, method, amount, note, created_by)
    VALUES (v_shift, inv.id, v_rid, 'refund', v_method, -v_cash_refund, NULLIF(btrim(COALESCE(p_reason, '')), ''), p_user_id);
  END IF;

  IF v_credit_part > 0 THEN
    PERFORM customer_post(inv.customer_id, 'return_credit', -v_credit_part, inv.id, NULL, NULL,
                          NULLIF(btrim(COALESCE(p_reason, '')), ''), p_user_id);
    UPDATE sale_invoices SET credit_reversed = credit_reversed + v_credit_part WHERE id = inv.id;
  END IF;

  PERFORM audit_event(p_user_id, p_username, 'تسجيل مرتجع', 'return', v_rid::text,
    jsonb_build_object('invoice_id', inv.id, 'medicine_name', it.medicine_name_snapshot, 'quantity', p_quantity,
                       'refund_amount', v_refund, 'credit_applied', v_credit_part, 'refund_method', v_method, 'restocked_units', v_restocked,
                       'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')));

  RETURN jsonb_build_object('return_id', v_rid, 'refund_amount', v_refund, 'credit_applied', v_credit_part,
                            'cash_refund', v_cash_refund, 'restocked_units', v_restocked,
                            'quantity_units', v_units, 'duplicate', false);
END;
$$;

COMMIT;
