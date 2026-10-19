-- ============================================================================
-- db/migration_004_purchases.sql
-- الخطوة 1: فواتير الشراء من الموردين + حسابات الموردين (مديونيات ودفعات)
--
-- شغّله بعد migration_002 و migration_003 (أو عبر: node db/migrate.js).
-- آمن لإعادة التشغيل (idempotent) ولا يحذف أي جدول أو بيانات.
--
-- اللي بيضيفه:
--   * purchase_invoices / purchase_invoice_items : فاتورة الشراء وبنودها (كل بند = تشغيلة)
--   * supplier_payments                          : دفعات الموردين (كل دفعة مربوطة بفاتورة)
--   * create_purchase_invoice()   : بتسجل الفاتورة + تنشئ التشغيلات (المخزون بيزيد عبر trigger التشغيلات)
--   * record_supplier_payment()   : دفعة على فاتورة محددة، أو دفعة على الحساب (بتتوزع على الأقدم أولًا)
--   * cancel_purchase_invoice()   : إلغاء فاتورة (بس لو مفيش دفعات ولا حاجة اتباعت من تشغيلاتها)
--   * v_supplier_balances         : رصيد كل مورد (المستحق + المتأخر)
-- ============================================================================

BEGIN;

-- تكلفة الحبة بدقة أعلى (علبة بـ 100 جنيه فيها 30 حبة = 3.3333 مش 3.33)
DO $$
BEGIN
  IF (SELECT numeric_scale FROM information_schema.columns
      WHERE table_name = 'batches' AND column_name = 'cost_price_unit') < 4 THEN
    ALTER TABLE batches ALTER COLUMN cost_price_unit TYPE NUMERIC(14,4);
  END IF;
END $$;

-- أنواع حركات مخزون جديدة (الإلغاء + تجهيز للخطوات الجاية: مرتجع مورد / إتلاف / جرد)
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase', 'sale', 'sale_void', 'return', 'adjustment',
                           'purchase_cancel', 'supplier_return', 'write_off', 'stocktake'));

-- ----------------------------------------------------------------------------
-- الجداول
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  invoice_number TEXT,                                   -- رقم فاتورة المورد (الورقية)
  invoice_date DATE NOT NULL DEFAULT pharmacy_today(),
  due_date DATE,                                         -- ميعاد الاستحقاق (للآجل)
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'cancelled')),
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  notes TEXT,
  idempotency_key TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  CHECK (paid_amount <= total_amount)
);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier ON purchase_invoices (supplier_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_date ON purchase_invoices (invoice_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_invoices_idem ON purchase_invoices (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- نفس رقم فاتورة المورد ميتسجلش مرتين (الملغاة مستثناة)
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_invoices_supplier_number
  ON purchase_invoices (supplier_id, lower(invoice_number)) WHERE invoice_number IS NOT NULL AND status = 'received';

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  batch_number TEXT,
  expiry_date DATE NOT NULL,
  entry_unit TEXT NOT NULL DEFAULT 'unit' CHECK (entry_unit IN ('unit', 'strip', 'box')),  -- وحدة الإدخال
  entry_quantity INTEGER NOT NULL CHECK (entry_quantity > 0),
  entry_cost NUMERIC(14,4) NOT NULL CHECK (entry_cost >= 0),                                -- سعر وحدة الإدخال
  quantity_units INTEGER NOT NULL CHECK (quantity_units > 0),                                 -- بالحبة
  cost_price_unit NUMERIC(14,4) NOT NULL CHECK (cost_price_unit >= 0),
  line_total NUMERIC(14,2) NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX IF NOT EXISTS idx_pii_invoice ON purchase_invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_pii_medicine ON purchase_invoice_items (medicine_id);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank', 'other')),
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments (supplier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_invoice ON supplier_payments (invoice_id);

-- ربط التشغيلة بفاتورة الشراء اللي دخلت بيها
ALTER TABLE batches ADD COLUMN IF NOT EXISTS purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batches_purchase_invoice ON batches (purchase_invoice_id);

-- ----------------------------------------------------------------------------
-- دفعة على فاتورة (دالة داخلية، بتفترض إن الفاتورة مقفولة FOR UPDATE)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _apply_supplier_payment(
  p_invoice purchase_invoices, p_amount NUMERIC, p_method TEXT, p_note TEXT, p_user_id INTEGER
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO supplier_payments (supplier_id, invoice_id, amount, method, note, created_by)
  VALUES (p_invoice.supplier_id, p_invoice.id, p_amount, p_method, NULLIF(btrim(p_note), ''), p_user_id);
  UPDATE purchase_invoices SET paid_amount = paid_amount + p_amount WHERE id = p_invoice.id;
END $$;

-- ----------------------------------------------------------------------------
-- تسجيل فاتورة شراء
--   p_items: JSON array، كل عنصر:
--     { medicine_id, batch_number, expiry_date: 'YYYY-MM-DD', unit: 'unit'|'strip'|'box', quantity, cost }
--     (cost = سعر وحدة الإدخال، والدالة بتحوّله لتكلفة الحبة)
--   p_paid: المدفوع وقت الاستلام (0 = آجل بالكامل)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_purchase_invoice(
  p_supplier_id INTEGER, p_invoice_number TEXT, p_invoice_date DATE, p_due_date DATE, p_notes TEXT,
  p_user_id INTEGER, p_username TEXT, p_items JSONB, p_paid NUMERIC DEFAULT 0, p_method TEXT DEFAULT 'cash',
  p_idempotency_key TEXT DEFAULT NULL
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
  v_expiry DATE;
  v_line NUMERIC;
  v_total NUMERIC := 0;
  v_batch_id INTEGER;
  v_bnum TEXT;
  v_count INTEGER := 0;
  v_today DATE := pharmacy_today();
BEGIN
  IF p_idempotency_key IS NOT NULL AND EXISTS (SELECT 1 FROM purchase_invoices WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'فاتورة الشراء اتسجلت قبل كده' USING ERRCODE = 'PH003';
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

  INSERT INTO purchase_invoices (supplier_id, invoice_number, invoice_date, due_date, notes, idempotency_key, created_by)
  VALUES (p_supplier_id, p_invoice_number, p_invoice_date, p_due_date, NULLIF(btrim(COALESCE(p_notes, '')), ''), p_idempotency_key, p_user_id)
  RETURNING * INTO v_inv;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_count := v_count + 1;
    BEGIN
      v_unit := COALESCE(v_item->>'unit', 'unit');
      v_qty := (v_item->>'quantity')::INTEGER;
      v_cost := (v_item->>'cost')::NUMERIC;
      v_expiry := (v_item->>'expiry_date')::DATE;
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
    IF v_expiry IS NULL OR v_expiry < v_today THEN
      RAISE EXCEPTION 'البند رقم % (%): تاريخ الصلاحية مفقود أو منتهي', v_count, v_med.name USING ERRCODE = 'PH001';
    END IF;

    v_factor := CASE v_unit
      WHEN 'unit'  THEN 1
      WHEN 'strip' THEN COALESCE(v_med.units_per_strip, 1)
      ELSE COALESCE(v_med.units_per_strip, 1) * COALESCE(v_med.strips_per_box, 1)
    END;
    v_units := v_qty * v_factor;
    v_unit_cost := ROUND(v_cost / v_factor, 4);
    v_line := ROUND(v_qty * v_cost, 2);
    v_total := v_total + v_line;
    v_bnum := NULLIF(btrim(COALESCE(v_item->>'batch_number', '')), '');

    -- التشغيلة: trigger التشغيلات هو اللي بيزوّد المخزون ويحدّث متوسط التكلفة ويسجل حركة 'purchase'
    INSERT INTO batches (medicine_id, supplier_id, batch_number, expiry_date, received_units, quantity_units,
                         cost_price_unit, purchase_invoice_id)
    VALUES (v_med.id, p_supplier_id, v_bnum, v_expiry, v_units, v_units, v_unit_cost, v_inv.id)
    RETURNING id INTO v_batch_id;

    INSERT INTO purchase_invoice_items (invoice_id, medicine_id, batch_id, batch_number, expiry_date,
                                        entry_unit, entry_quantity, entry_cost, quantity_units, cost_price_unit, line_total)
    VALUES (v_inv.id, v_med.id, v_batch_id, v_bnum, v_expiry, v_unit, v_qty, v_cost, v_units, v_unit_cost, v_line);
  END LOOP;

  IF COALESCE(p_paid, 0) > v_total THEN
    RAISE EXCEPTION 'المدفوع (%) أكبر من إجمالي الفاتورة (%)', p_paid, v_total USING ERRCODE = 'PH001';
  END IF;

  UPDATE purchase_invoices SET total_amount = v_total WHERE id = v_inv.id RETURNING * INTO v_inv;

  IF COALESCE(p_paid, 0) > 0 THEN
    PERFORM _apply_supplier_payment(v_inv, ROUND(p_paid, 2), p_method, 'دفعة وقت الاستلام', p_user_id);
  END IF;

  PERFORM audit_event(p_user_id, p_username, 'تسجيل فاتورة شراء', 'purchase_invoice', v_inv.id::text,
    jsonb_build_object('supplier_id', p_supplier_id, 'invoice_number', p_invoice_number, 'total', v_total,
                       'paid', COALESCE(p_paid, 0), 'items', v_count));
  RETURN v_inv.id;
END $$;

-- ----------------------------------------------------------------------------
-- دفعة لمورد
--   p_invoice_id محدد  → على الفاتورة دي بس (لا تزيد عن المتبقي)
--   p_invoice_id NULL  → على الحساب: بتتوزع على فواتير المورد الأقدم أولًا
-- بترجّع JSON فيه التوزيع.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_supplier_payment(
  p_supplier_id INTEGER, p_invoice_id INTEGER, p_amount NUMERIC, p_method TEXT, p_note TEXT,
  p_user_id INTEGER, p_username TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_inv purchase_invoices;
  v_left NUMERIC;
  v_take NUMERIC;
  v_alloc JSONB := '[]'::jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'المبلغ لازم يكون أكبر من صفر' USING ERRCODE = 'PH001';
  END IF;
  IF p_method NOT IN ('cash', 'bank', 'other') THEN
    RAISE EXCEPTION 'طريقة الدفع غير صحيحة' USING ERRCODE = 'PH001';
  END IF;
  p_amount := ROUND(p_amount, 2);
  PERFORM 1 FROM suppliers WHERE id = p_supplier_id FOR UPDATE;   -- بيسلسل الدفعات المتزامنة لنفس المورد
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود' USING ERRCODE = 'PH002'; END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM purchase_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND OR v_inv.supplier_id <> p_supplier_id THEN
      RAISE EXCEPTION 'الفاتورة غير موجودة لهذا المورد' USING ERRCODE = 'PH002';
    END IF;
    IF v_inv.status <> 'received' THEN
      RAISE EXCEPTION 'الفاتورة ملغاة' USING ERRCODE = 'PH001';
    END IF;
    IF p_amount > v_inv.total_amount - v_inv.paid_amount THEN
      RAISE EXCEPTION 'المبلغ أكبر من المتبقي على الفاتورة (%)', v_inv.total_amount - v_inv.paid_amount USING ERRCODE = 'PH001';
    END IF;
    PERFORM _apply_supplier_payment(v_inv, p_amount, p_method, p_note, p_user_id);
    v_alloc := jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', p_amount));
  ELSE
    v_left := p_amount;
    FOR v_inv IN
      SELECT * FROM purchase_invoices
      WHERE supplier_id = p_supplier_id AND status = 'received' AND paid_amount < total_amount
      ORDER BY invoice_date, id FOR UPDATE
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_left, v_inv.total_amount - v_inv.paid_amount);
      PERFORM _apply_supplier_payment(v_inv, v_take, p_method, p_note, p_user_id);
      v_alloc := v_alloc || jsonb_build_object('invoice_id', v_inv.id, 'amount', v_take);
      v_left := v_left - v_take;
    END LOOP;
    IF v_left > 0 THEN
      RAISE EXCEPTION 'المبلغ أكبر من إجمالي المستحق للمورد (زيادة %)', v_left USING ERRCODE = 'PH001';
    END IF;
  END IF;

  PERFORM audit_event(p_user_id, p_username, 'دفعة لمورد', 'supplier', p_supplier_id::text,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id, 'allocations', v_alloc));
  RETURN v_alloc;
END $$;

-- ----------------------------------------------------------------------------
-- إلغاء فاتورة شراء: بس لو (1) مفيش دفعات عليها، (2) كل تشغيلاتها لسه كاملة (متباعش ولا اتعدل منها حاجة).
-- غير كده: استخدم مرتجع مورد / إتلاف (الخطوة الجاية).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_purchase_invoice(
  p_invoice_id INTEGER, p_user_id INTEGER, p_username TEXT, p_reason TEXT
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_inv purchase_invoices;
  v_it RECORD;
  v_b batches;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'سبب الإلغاء مطلوب' USING ERRCODE = 'PH001';
  END IF;
  SELECT * INTO v_inv FROM purchase_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الفاتورة غير موجودة' USING ERRCODE = 'PH002'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'الفاتورة ملغاة بالفعل' USING ERRCODE = 'PH003'; END IF;
  IF v_inv.paid_amount > 0 THEN
    RAISE EXCEPTION 'عليها دفعات (%)؛ مينفعش تتلغي. سجّل مرتجع للمورد بدلًا من الإلغاء', v_inv.paid_amount USING ERRCODE = 'PH001';
  END IF;

  FOR v_it IN SELECT * FROM purchase_invoice_items WHERE invoice_id = p_invoice_id ORDER BY id LOOP
    IF v_it.batch_id IS NULL THEN
      RAISE EXCEPTION 'تشغيلة أحد البنود اتحذفت؛ مينفعش الإلغاء' USING ERRCODE = 'PH001';
    END IF;
    PERFORM 1 FROM medicines WHERE id = v_it.medicine_id FOR UPDATE;
    SELECT * INTO v_b FROM batches WHERE id = v_it.batch_id FOR UPDATE;
    IF v_b.quantity_units <> v_it.quantity_units THEN
      RAISE EXCEPTION 'مينفعش الإلغاء: جزء من تشغيلة % اتباع أو اتعدّل (المتبقي % من %)',
        COALESCE(v_it.batch_number, v_b.id::text), v_b.quantity_units, v_it.quantity_units USING ERRCODE = 'PH001';
    END IF;
  END LOOP;

  FOR v_it IN SELECT * FROM purchase_invoice_items WHERE invoice_id = p_invoice_id ORDER BY id LOOP
    UPDATE batches SET quantity_units = 0 WHERE id = v_it.batch_id;   -- trigger المزامنة بينقّص المخزون
    INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id, user_id, note)
    VALUES (v_it.medicine_id, v_it.batch_id, 'purchase_cancel', -v_it.quantity_units, 'purchase_invoice', p_invoice_id, p_user_id, p_reason);
  END LOOP;

  UPDATE purchase_invoices
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_user_id, cancel_reason = btrim(p_reason)
  WHERE id = p_invoice_id;

  PERFORM audit_event(p_user_id, p_username, 'إلغاء فاتورة شراء', 'purchase_invoice', p_invoice_id::text,
    jsonb_build_object('reason', btrim(p_reason), 'total', v_inv.total_amount));
END $$;

-- ----------------------------------------------------------------------------
-- رصيد الموردين
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_supplier_balances AS
SELECT
  s.id AS supplier_id,
  s.name,
  COUNT(pi.id) FILTER (WHERE pi.status = 'received')::int AS invoices_count,
  COALESCE(SUM(pi.total_amount) FILTER (WHERE pi.status = 'received'), 0)::numeric(14,2) AS total_invoiced,
  COALESCE(SUM(pi.paid_amount) FILTER (WHERE pi.status = 'received'), 0)::numeric(14,2) AS total_paid,
  COALESCE(SUM(pi.total_amount - pi.paid_amount) FILTER (WHERE pi.status = 'received'), 0)::numeric(14,2) AS balance_due,
  COALESCE(SUM(pi.total_amount - pi.paid_amount)
           FILTER (WHERE pi.status = 'received' AND pi.due_date IS NOT NULL AND pi.due_date < pharmacy_today()), 0)::numeric(14,2) AS overdue_due
FROM suppliers s
LEFT JOIN purchase_invoices pi ON pi.supplier_id = s.id
GROUP BY s.id, s.name;

COMMIT;
