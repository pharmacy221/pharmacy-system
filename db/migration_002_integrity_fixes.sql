-- ============================================================================
-- db/migration_002_integrity_fixes.sql
-- إصلاحات سلامة البيانات: FEFO + إلغاء الفواتير + المرتجعات + المخزون/التشغيلات
-- + حسابات المبيعات + الورديات والخزنة.
--
-- شغّله بعد pharmacy_schema.sql و migration_forms.sql.
-- آمن لإعادة التشغيل أكتر من مرة (idempotent) ولا يحذف أي جدول أو عمود، ولا يغيّر
-- أرقام المخزون الحالية ولا قيم الفواتير القديمة (الأعمدة الجديدة بس هي اللي بتتملا).
--
-- قبل التشغيل على بيانات حقيقية:
--   1) خد نسخة احتياطية:  pg_dump "$DATABASE_URL" -Fc -f backup_before_002.dump
--   2) شغّل:  node db/report-stock-mismatch.js   (تقرير فروق المخزون - قراءة فقط)
--   3) اقفل أي وردية مفتوحة قبل التحديث (الفواتير القديمة مش مربوطة بوردية).
-- التراجع: db/migration_002_rollback.sql
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0) المنطقة الزمنية المعتمدة للصيدلية (افتراضي: توقيت القاهرة).
--    تتغير من جدول settings (key = 'timezone'). كل حسابات "النهارده/الشهر"
--    وصلاحية التشغيلات بتعتمد على التاريخ المحلي ده مش توقيت السيرفر (UTC).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pharmacy_tz() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'timezone'), ''), 'Africa/Cairo')
$$;

CREATE OR REPLACE FUNCTION pharmacy_today() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE pharmacy_tz())::date
$$;

CREATE OR REPLACE FUNCTION pharmacy_date(ts timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (ts AT TIME ZONE pharmacy_tz())::date
$$;

-- سجل التدقيق (داخل نفس الـ transaction بتاعة العملية الحساسة)
CREATE OR REPLACE FUNCTION audit_event(
  p_user_id INTEGER, p_username TEXT, p_action TEXT,
  p_entity_type TEXT, p_entity_id TEXT, p_details JSONB DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO activity_log (user_id, action, details)
  VALUES (p_user_id, p_action,
          (jsonb_build_object('username', p_username, 'entity_type', p_entity_type, 'entity_id', p_entity_id)
           || COALESCE(p_details, '{}'::jsonb))::text)
$$;

-- ----------------------------------------------------------------------------
-- 1) أعمدة وجداول جديدة
-- ----------------------------------------------------------------------------

-- الفواتير: حالة (مكتملة / ملغاة) + ربط بالوردية + مفتاح منع التكرار + بيانات الإلغاء
ALTER TABLE sale_invoices
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE sale_invoices DROP CONSTRAINT IF EXISTS chk_invoice_status;
ALTER TABLE sale_invoices ADD CONSTRAINT chk_invoice_status CHECK (status IN ('completed', 'voided')) NOT VALID;
ALTER TABLE sale_invoices DROP CONSTRAINT IF EXISTS chk_invoice_total_nonneg;
ALTER TABLE sale_invoices ADD CONSTRAINT chk_invoice_total_nonneg CHECK (total >= 0) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_idempotency ON sale_invoices (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_shift ON sale_invoices (shift_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status_created ON sale_invoices (status, created_at);

-- بنود الفاتورة: التكلفة بدقة أعلى (كانت NUMERIC(12,2) فبتضيع كسور التكلفة)
ALTER TABLE sale_items ALTER COLUMN cost_price_unit_snapshot TYPE NUMERIC(14,4);
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS chk_sale_items_qty;
ALTER TABLE sale_items ADD CONSTRAINT chk_sale_items_qty CHECK (quantity > 0 AND quantity_units > 0) NOT VALID;

-- المخزون والتشغيلات: ممنوع السالب على مستوى قاعدة البيانات
-- (NOT VALID = بيتطبق على أي كتابة جديدة من غير ما يوقف الترحيل لو فيه بيانات قديمة غلط)
ALTER TABLE medicines DROP CONSTRAINT IF EXISTS chk_medicines_stock_nonneg;
ALTER TABLE medicines ADD CONSTRAINT chk_medicines_stock_nonneg CHECK (stock_units >= 0) NOT VALID;
ALTER TABLE batches DROP CONSTRAINT IF EXISTS chk_batches_qty_nonneg;
ALTER TABLE batches ADD CONSTRAINT chk_batches_qty_nonneg CHECK (quantity_units >= 0 AND received_units >= 0) NOT VALID;

-- أي تشغيلة انخصم منها لكل بند بيع (التشغيلة + الكمية) — أساس الإلغاء والمرتجع الدقيق
CREATE TABLE IF NOT EXISTS sale_item_batches (
  id SERIAL PRIMARY KEY,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  quantity_units INTEGER NOT NULL CHECK (quantity_units > 0),
  reversed_units INTEGER NOT NULL DEFAULT 0,          -- اللي اتعكس منها (مرتجع أو إلغاء)
  cost_price_unit NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (reversed_units >= 0 AND reversed_units <= quantity_units)
);
CREATE INDEX IF NOT EXISTS idx_sib_item ON sale_item_batches (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sib_batch ON sale_item_batches (batch_id);

-- سجل حركات المخزون (كل زيادة/نقص بتتسجل مع مرجعها)
CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'sale_void', 'return', 'adjustment')),
  quantity_units INTEGER NOT NULL,                    -- موجب = دخول، سالب = خروج
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_medicine ON stock_movements (medicine_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements (ref_type, ref_id);

-- تسويات المخزون اليدوية (قبل / بعد / الفرق / السبب / المستخدم)
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id SERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  quantity_before INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- المرتجعات: ربط ببند البيع الأصلي + طريقة الرد + الكمية اللي رجعت فعلاً + مفتاح منع التكرار
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS refund_method TEXT,
  ADD COLUMN IF NOT EXISTS restocked_units INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_recovered NUMERIC(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE returns DROP CONSTRAINT IF EXISTS chk_returns_refund_method;
ALTER TABLE returns ADD CONSTRAINT chk_returns_refund_method
  CHECK (refund_method IS NULL OR refund_method IN ('cash', 'card', 'other', 'none')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_idempotency ON returns (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_returns_sale_item ON returns (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_returns_invoice ON returns (invoice_id);

-- ربط المرتجعات القديمة ببند البيع (بس لو الربط واضح: بند واحد بنفس الصنف والوحدة في الفاتورة)
-- بيملا الأعمدة الجديدة فقط ولا يغيّر أي قيمة قديمة.
UPDATE returns r
SET sale_item_id = x.item_id
FROM (
  SELECT r2.id AS rid, MIN(si.id) AS item_id, COUNT(*) AS n
  FROM returns r2
  JOIN sale_items si ON si.invoice_id = r2.invoice_id AND si.medicine_id = r2.medicine_id AND si.sale_unit = r2.sale_unit
  WHERE r2.sale_item_id IS NULL
  GROUP BY r2.id
) x
WHERE r.id = x.rid AND x.n = 1;

UPDATE returns SET restocked_units = quantity_units WHERE restocked AND restocked_units = 0;

UPDATE returns r
SET cost_recovered = ROUND(si.cost_price_unit_snapshot * r.restocked_units, 4)
FROM sale_items si
WHERE si.id = r.sale_item_id AND r.restocked_units > 0 AND r.cost_recovered = 0;

-- حركات الخزنة: كل داخل/خارج نقدي أو بطاقة مرتبط بوردية
CREATE TABLE IF NOT EXISTS cash_movements (
  id SERIAL PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  invoice_id INTEGER REFERENCES sale_invoices(id) ON DELETE SET NULL,
  return_id INTEGER REFERENCES returns(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('sale', 'refund', 'void_refund', 'deposit', 'withdrawal')),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'card', 'other')),
  amount NUMERIC(12,2) NOT NULL,                      -- موجب = داخل، سالب = خارج
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (
    (movement_type IN ('sale', 'deposit') AND amount > 0) OR
    (movement_type IN ('refund', 'void_refund', 'withdrawal') AND amount < 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements (shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_invoice ON cash_movements (invoice_id);

-- الورديات: النقدية المتوقعة وقت الإغلاق + العجز/الزيادة + مين قفلها
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS expected_cash NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS cash_difference NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS close_note TEXT;

-- وردية مفتوحة واحدة فقط لكل مستخدم (لو فيه تكرار قديم بنكتفي بتنبيه ومش بنوقف الترحيل)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shifts WHERE closed_at IS NULL GROUP BY opened_by HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'تنبيه: فيه مستخدم عنده أكتر من وردية مفتوحة. اقفل الزايدة ثم أعد تشغيل الملف لإنشاء القيد uq_one_open_shift_per_user';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_open_shift_per_user ON shifts (opened_by) WHERE closed_at IS NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2) مصدر الحقيقة للمخزون: التشغيلات (batches.quantity_units).
--    medicines.stock_units = مجموع التشغيلات، ويتحدّث بس من خلال trigger على batches.
--    أي UPDATE مباشر على stock_units من برّه ده بيترفض.
--    (الفروق القديمة الموجودة فعلاً مبتتلمسش — شوف db/report-stock-mismatch.js)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_stock_units() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.stock_units IS DISTINCT FROM OLD.stock_units
     AND COALESCE(current_setting('app.stock_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'تعديل المخزون مباشرة غير مسموح؛ استخدم استلام تشغيلة أو تسوية المخزون'
      USING ERRCODE = 'PH001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_stock_units ON medicines;
CREATE TRIGGER trg_guard_stock_units
BEFORE UPDATE OF stock_units ON medicines
FOR EACH ROW EXECUTE FUNCTION guard_stock_units();

CREATE OR REPLACE FUNCTION batches_sync_stock() RETURNS TRIGGER AS $$
DECLARE
  d INTEGER;
  mid INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    mid := NEW.medicine_id; d := NEW.quantity_units;
    IF d > 0 THEN
      INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id, note)
      VALUES (NEW.medicine_id, NEW.id, 'purchase', d, 'batch', NEW.id, NEW.batch_number);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    mid := OLD.medicine_id; d := -OLD.quantity_units;
  ELSE
    IF NEW.medicine_id <> OLD.medicine_id THEN
      RAISE EXCEPTION 'مينفعش تنقل تشغيلة لصنف تاني' USING ERRCODE = 'PH001';
    END IF;
    mid := NEW.medicine_id; d := NEW.quantity_units - OLD.quantity_units;
  END IF;

  IF d <> 0 THEN
    PERFORM set_config('app.stock_write', 'on', true);
    UPDATE medicines SET stock_units = stock_units + d WHERE id = mid;
    PERFORM set_config('app.stock_write', 'off', true);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_batches_sync_stock ON batches;
CREATE TRIGGER trg_batches_sync_stock
AFTER INSERT OR UPDATE OF quantity_units, medicine_id OR DELETE ON batches
FOR EACH ROW EXECUTE FUNCTION batches_sync_stock();

-- استلام تشغيلة: بنحدّث متوسط التكلفة المرجّح بس. الزيادة في المخزون بتتم في trigger المزامنة فوق.
CREATE OR REPLACE FUNCTION apply_new_batch() RETURNS TRIGGER AS $$
DECLARE
  old_stock INTEGER;
  old_cost NUMERIC(12,2);
BEGIN
  IF NEW.quantity_units IS NULL OR NEW.quantity_units = 0 THEN
    NEW.quantity_units := NEW.received_units;
  END IF;

  SELECT stock_units, cost_price_unit INTO old_stock, old_cost
  FROM medicines WHERE id = NEW.medicine_id FOR UPDATE;

  UPDATE medicines
  SET cost_price_unit = CASE
        WHEN (COALESCE(old_stock, 0) + NEW.quantity_units) > 0 THEN
          ROUND(((COALESCE(old_stock, 0) * COALESCE(old_cost, 0)) + (NEW.quantity_units * NEW.cost_price_unit))
                / (COALESCE(old_stock, 0) + NEW.quantity_units), 2)
        ELSE NEW.cost_price_unit
      END
  WHERE id = NEW.medicine_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- (الـ trigger trg_apply_new_batch موجود من قبل ومربوط بنفس اسم الدالة)

-- ----------------------------------------------------------------------------
-- 3) البيع: تحويل الوحدات + خصم FEFO من التشغيلات الصالحة فقط
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_quantity_units() RETURNS TRIGGER AS $$
DECLARE
  ups INTEGER;
  spb INTEGER;
  found_med BOOLEAN;
BEGIN
  IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'الكمية لازم تكون أكبر من صفر' USING ERRCODE = 'PH001';
  END IF;

  SELECT units_per_strip, strips_per_box, true INTO ups, spb, found_med
  FROM medicines WHERE id = NEW.medicine_id;

  IF NEW.medicine_id IS NULL OR found_med IS NOT TRUE THEN
    RAISE EXCEPTION 'الصنف غير موجود' USING ERRCODE = 'PH001';
  END IF;

  ups := COALESCE(ups, 1);
  spb := COALESCE(spb, 1);

  NEW.quantity_units := CASE NEW.sale_unit
    WHEN 'unit'  THEN NEW.quantity
    WHEN 'strip' THEN NEW.quantity * ups
    WHEN 'box'   THEN NEW.quantity * ups * spb
    ELSE NEW.quantity
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION deduct_stock_fefo() RETURNS TRIGGER AS $$
DECLARE
  v_today DATE := pharmacy_today();
  v_remaining INTEGER := NEW.quantity_units;
  v_avail INTEGER;
  v_cost NUMERIC(18,4) := 0;
  v_name TEXT;
  b RECORD;
  take INTEGER;
BEGIN
  -- قفل صف الصنف: أي عمليتين بيع/إلغاء/مرتجع على نفس الصنف بيتنفذوا بالدور
  SELECT name INTO v_name FROM medicines WHERE id = NEW.medicine_id FOR UPDATE;

  SELECT COALESCE(SUM(quantity_units), 0) INTO v_avail
  FROM batches
  WHERE medicine_id = NEW.medicine_id AND quantity_units > 0 AND expiry_date >= v_today;

  IF v_avail < NEW.quantity_units THEN
    RAISE EXCEPTION 'الكمية الصالحة للبيع غير كافية للصنف "%" (المتاح الصالح: %، المطلوب: %)',
      v_name, v_avail, NEW.quantity_units USING ERRCODE = 'PH001';
  END IF;

  FOR b IN
    SELECT id, quantity_units, cost_price_unit
    FROM batches
    WHERE medicine_id = NEW.medicine_id AND quantity_units > 0 AND expiry_date >= v_today
    ORDER BY expiry_date ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    take := LEAST(b.quantity_units, v_remaining);

    UPDATE batches SET quantity_units = quantity_units - take WHERE id = b.id;
    INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity_units, cost_price_unit)
    VALUES (NEW.id, b.id, take, b.cost_price_unit);
    INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, ref_id)
    VALUES (NEW.medicine_id, b.id, 'sale', -take, 'sale_item', NEW.id);

    v_cost := v_cost + (take * b.cost_price_unit);
    v_remaining := v_remaining - take;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'تعذر خصم الكمية بالكامل من التشغيلات الصالحة' USING ERRCODE = 'PH001';
  END IF;

  UPDATE sale_items SET cost_price_unit_snapshot = ROUND(v_cost / NEW.quantity_units, 4) WHERE id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- كان BEFORE INSERT؛ بقى AFTER عشان نسجّل التشغيلات المخصوم منها مربوطة برقم البند
DROP TRIGGER IF EXISTS trg_deduct_stock_fefo ON sale_items;
CREATE TRIGGER trg_deduct_stock_fefo
AFTER INSERT ON sale_items
FOR EACH ROW EXECUTE FUNCTION deduct_stock_fefo();

-- بنود البيع غير قابلة للتعديل أو الحذف بعد التسجيل (التصحيح بالإلغاء/المرتجع فقط)
CREATE OR REPLACE FUNCTION protect_sale_items() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'مينفعش حذف بنود الفواتير؛ استخدم إلغاء الفاتورة أو المرتجع' USING ERRCODE = 'PH001';
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR (NEW.medicine_id IS DISTINCT FROM OLD.medicine_id AND NEW.medicine_id IS NOT NULL)
     OR NEW.sale_unit IS DISTINCT FROM OLD.sale_unit
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.quantity_units IS DISTINCT FROM OLD.quantity_units
     OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
     OR NEW.total IS DISTINCT FROM OLD.total THEN
    RAISE EXCEPTION 'مينفعش تعديل بند فاتورة بعد تسجيله' USING ERRCODE = 'PH001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_sale_items ON sale_items;
CREATE TRIGGER trg_protect_sale_items
BEFORE UPDATE OR DELETE ON sale_items
FOR EACH ROW EXECUTE FUNCTION protect_sale_items();

-- الفواتير: ممنوع الحذف النهائي، وممنوع إرجاع فاتورة ملغاة لحالة "مكتملة"
CREATE OR REPLACE FUNCTION protect_sale_invoices() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'مينفعش حذف الفواتير نهائيًا؛ استخدم إلغاء الفاتورة' USING ERRCODE = 'PH001';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'الفاتورة الملغاة مينفعش ترجع مكتملة' USING ERRCODE = 'PH001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_sale_invoices ON sale_invoices;
CREATE TRIGGER trg_protect_sale_invoices
BEFORE UPDATE OR DELETE ON sale_invoices
FOR EACH ROW EXECUTE FUNCTION protect_sale_invoices();

CREATE OR REPLACE FUNCTION refresh_invoice_total() RETURNS TRIGGER AS $$
BEGIN
  UPDATE sale_invoices
  SET total = GREATEST((SELECT COALESCE(SUM(total), 0) FROM sale_items WHERE invoice_id = NEW.invoice_id) - COALESCE(discount, 0), 0)
  WHERE id = NEW.invoice_id AND status = 'completed';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- إنهاء الفاتورة: الإجمالي والخصم بيتحسبوا من البنود في قاعدة البيانات + تسجيل الدفع في الخزنة
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

-- ----------------------------------------------------------------------------
-- 4) إلغاء الفاتورة (Void) بدل الحذف
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 5) المرتجعات
-- ----------------------------------------------------------------------------
-- القديم كان بيرجّع المخزون بـ trigger تلقائي على أي INSERT (ومن غير ما يعرف التشغيلة).
-- دلوقتي المرتجع بيتسجل من create_return() بس، وهي المسؤولة عن المخزون والخزنة.
DROP TRIGGER IF EXISTS trg_restock_on_return ON returns;

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

-- ----------------------------------------------------------------------------
-- 6) تسوية المخزون اليدوية (بدل UPDATE مباشر على stock_units)
--    السياسة: الزيادة بتتضاف على أطول تشغيلة صلاحية (لسه صالحة)، والنقص بيتخصم من
--    أقرب تشغيلة صلاحية أولاً. الفرق اللي ملوش تشغيلات (بيانات قديمة) بيتخصم من الرصيد
--    غير المسجّل بس. كل ده بيتسجل في stock_adjustments و stock_movements و activity_log.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adjust_medicine_stock(
  p_medicine_id INTEGER, p_new_total INTEGER, p_reason TEXT, p_user_id INTEGER, p_username TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  m medicines%ROWTYPE;
  v_today DATE := pharmacy_today();
  v_diff INTEGER;
  v_need INTEGER;
  v_take INTEGER;
  v_batches_sum INTEGER;
  v_unbatched INTEGER;
  v_batch INTEGER;
  v_reason TEXT := COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'تسوية يدوية');
  b RECORD;
BEGIN
  IF p_new_total IS NULL OR p_new_total < 0 THEN
    RAISE EXCEPTION 'الكمية الجديدة لازم تكون صفر أو أكتر' USING ERRCODE = 'PH001';
  END IF;

  SELECT * INTO m FROM medicines WHERE id = p_medicine_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الصنف غير موجود' USING ERRCODE = 'PH002';
  END IF;

  v_diff := p_new_total - m.stock_units;
  IF v_diff = 0 THEN
    RETURN jsonb_build_object('difference', 0, 'before', m.stock_units, 'after', m.stock_units);
  END IF;

  IF v_diff > 0 THEN
    SELECT id INTO v_batch FROM batches
    WHERE medicine_id = m.id AND expiry_date >= v_today
    ORDER BY expiry_date DESC, id DESC LIMIT 1 FOR UPDATE;
    IF v_batch IS NULL THEN
      RAISE EXCEPTION 'مفيش تشغيلة صالحة نضيف عليها الزيادة؛ سجّل استلام تشغيلة بتاريخ صلاحية من صفحة التشغيلات'
        USING ERRCODE = 'PH001';
    END IF;
    UPDATE batches SET quantity_units = quantity_units + v_diff WHERE id = v_batch;
    INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, user_id, note)
    VALUES (m.id, v_batch, 'adjustment', v_diff, 'adjustment', p_user_id, v_reason);
  ELSE
    v_need := -v_diff;
    SELECT COALESCE(SUM(quantity_units), 0) INTO v_batches_sum FROM batches WHERE medicine_id = m.id;
    v_unbatched := GREATEST(m.stock_units - v_batches_sum, 0);
    IF v_need > v_batches_sum + v_unbatched THEN
      RAISE EXCEPTION 'النقص المطلوب أكبر من المخزون المسجل' USING ERRCODE = 'PH001';
    END IF;

    FOR b IN SELECT id, quantity_units FROM batches
             WHERE medicine_id = m.id AND quantity_units > 0
             ORDER BY expiry_date ASC, id ASC FOR UPDATE
    LOOP
      EXIT WHEN v_need <= 0;
      v_take := LEAST(b.quantity_units, v_need);
      UPDATE batches SET quantity_units = quantity_units - v_take WHERE id = b.id;
      INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, user_id, note)
      VALUES (m.id, b.id, 'adjustment', -v_take, 'adjustment', p_user_id, v_reason);
      v_need := v_need - v_take;
    END LOOP;

    IF v_need > 0 THEN
      PERFORM set_config('app.stock_write', 'on', true);
      UPDATE medicines SET stock_units = stock_units - v_need WHERE id = m.id;
      PERFORM set_config('app.stock_write', 'off', true);
      INSERT INTO stock_movements (medicine_id, batch_id, movement_type, quantity_units, ref_type, user_id, note)
      VALUES (m.id, NULL, 'adjustment', -v_need, 'adjustment', p_user_id, v_reason || ' (رصيد غير مسجل في تشغيلات)');
    END IF;
  END IF;

  INSERT INTO stock_adjustments (medicine_id, quantity_before, quantity_after, difference, reason, created_by)
  VALUES (m.id, m.stock_units, p_new_total, v_diff, v_reason, p_user_id);

  PERFORM audit_event(p_user_id, p_username, 'تسوية مخزون', 'medicine', m.id::text,
    jsonb_build_object('medicine_name', m.name, 'old_value', m.stock_units, 'new_value', p_new_total,
                       'difference', v_diff, 'reason', v_reason));

  RETURN jsonb_build_object('difference', v_diff, 'before', m.stock_units, 'after', p_new_total);
END;
$$;

-- تقرير الفروق بين إجمالي المخزون ومجموع التشغيلات (قراءة فقط — مفيش تصحيح تلقائي)
CREATE OR REPLACE VIEW v_stock_batch_mismatch AS
SELECT m.id AS medicine_id, m.name, m.stock_units,
       COALESCE(b.total_units, 0) AS batches_units,
       m.stock_units - COALESCE(b.total_units, 0) AS difference
FROM medicines m
LEFT JOIN (SELECT medicine_id, SUM(quantity_units)::int AS total_units FROM batches GROUP BY medicine_id) b
       ON b.medicine_id = m.id
WHERE m.stock_units <> COALESCE(b.total_units, 0);

-- ----------------------------------------------------------------------------
-- 7) الورديات والخزنة
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shift_summary(p_shift_id INTEGER)
RETURNS TABLE (
  opening_balance NUMERIC, cash_sales NUMERIC, card_sales NUMERIC, other_sales NUMERIC,
  cash_refunds NUMERIC, other_refunds NUMERIC, deposits NUMERIC, withdrawals NUMERIC,
  expected_cash NUMERIC, invoice_count BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT s.opening_balance,
         COALESCE(SUM(c.amount) FILTER (WHERE c.movement_type = 'sale' AND c.method = 'cash'), 0),
         COALESCE(SUM(c.amount) FILTER (WHERE c.movement_type = 'sale' AND c.method = 'card'), 0),
         COALESCE(SUM(c.amount) FILTER (WHERE c.movement_type = 'sale' AND c.method = 'other'), 0),
         COALESCE(-SUM(c.amount) FILTER (WHERE c.movement_type IN ('refund', 'void_refund') AND c.method = 'cash'), 0),
         COALESCE(-SUM(c.amount) FILTER (WHERE c.movement_type IN ('refund', 'void_refund') AND c.method <> 'cash'), 0),
         COALESCE(SUM(c.amount) FILTER (WHERE c.movement_type = 'deposit'), 0),
         COALESCE(-SUM(c.amount) FILTER (WHERE c.movement_type = 'withdrawal'), 0),
         COALESCE(s.opening_balance, 0) + COALESCE(SUM(c.amount) FILTER (WHERE c.method = 'cash'), 0),
         (SELECT COUNT(*) FROM sale_invoices i WHERE i.shift_id = s.id AND i.status = 'completed')
  FROM shifts s
  LEFT JOIN cash_movements c ON c.shift_id = s.id
  WHERE s.id = p_shift_id
  GROUP BY s.id, s.opening_balance
$$;

CREATE OR REPLACE FUNCTION record_shift_cash(
  p_shift_id INTEGER, p_user_id INTEGER, p_username TEXT, p_type TEXT, p_amount NUMERIC, p_note TEXT
) RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  s shifts%ROWTYPE;
  v_expected NUMERIC;
BEGIN
  IF p_type NOT IN ('deposit', 'withdrawal') THEN
    RAISE EXCEPTION 'نوع الحركة غير صحيح' USING ERRCODE = 'PH001';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'المبلغ لازم يكون أكبر من صفر' USING ERRCODE = 'PH001';
  END IF;

  SELECT * INTO s FROM shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة' USING ERRCODE = 'PH002'; END IF;
  IF s.closed_at IS NOT NULL THEN RAISE EXCEPTION 'الوردية مغلقة' USING ERRCODE = 'PH003'; END IF;
  IF s.opened_by IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'الوردية دي مش بتاعتك' USING ERRCODE = 'PH001';
  END IF;

  IF p_type = 'withdrawal' THEN
    SELECT expected_cash INTO v_expected FROM shift_summary(s.id);
    IF p_amount > v_expected THEN
      RAISE EXCEPTION 'مبلغ السحب أكبر من النقدية المتوقعة في الدرج (%)', v_expected USING ERRCODE = 'PH001';
    END IF;
  END IF;

  INSERT INTO cash_movements (shift_id, movement_type, method, amount, note, created_by)
  VALUES (s.id, p_type, 'cash', CASE WHEN p_type = 'deposit' THEN p_amount ELSE -p_amount END,
          NULLIF(btrim(COALESCE(p_note, '')), ''), p_user_id);

  PERFORM audit_event(p_user_id, p_username,
    CASE WHEN p_type = 'deposit' THEN 'إيداع نقدية في الوردية' ELSE 'سحب نقدية من الوردية' END,
    'shift', s.id::text, jsonb_build_object('total', p_amount, 'notes', NULLIF(btrim(COALESCE(p_note, '')), '')));

  SELECT expected_cash INTO v_expected FROM shift_summary(s.id);
  RETURN v_expected;
END;
$$;

CREATE OR REPLACE FUNCTION close_shift(
  p_shift_id INTEGER, p_user_id INTEGER, p_username TEXT, p_actual NUMERIC, p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  s shifts%ROWTYPE;
  v_expected NUMERIC;
  v_diff NUMERIC;
BEGIN
  IF p_actual IS NULL OR p_actual < 0 THEN
    RAISE EXCEPTION 'النقدية الفعلية لازم تكون صفر أو أكتر' USING ERRCODE = 'PH001';
  END IF;

  SELECT * INTO s FROM shifts WHERE id = p_shift_id FOR UPDATE;   -- بيمنع الإغلاق المزدوج
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة' USING ERRCODE = 'PH002'; END IF;
  IF s.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'الوردية دي اتقفلت بالفعل' USING ERRCODE = 'PH003';
  END IF;
  IF s.opened_by IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'الوردية دي مش بتاعتك' USING ERRCODE = 'PH001';
  END IF;

  SELECT expected_cash INTO v_expected FROM shift_summary(s.id);
  v_diff := p_actual - v_expected;

  UPDATE shifts
  SET closing_balance = p_actual, expected_cash = v_expected, cash_difference = v_diff,
      closed_at = now(), closed_by = p_user_id, close_note = NULLIF(btrim(COALESCE(p_note, '')), '')
  WHERE id = s.id;

  PERFORM audit_event(p_user_id, p_username, 'إغلاق وردية', 'shift', s.id::text,
    jsonb_build_object('expected_cash', v_expected, 'actual_cash', p_actual, 'difference', v_diff));

  RETURN jsonb_build_object('shift_id', s.id, 'expected_cash', v_expected, 'actual_cash', p_actual, 'difference', v_diff);
END;
$$;

-- ----------------------------------------------------------------------------
-- 8) حسابات المبيعات المشتركة (Dashboard + التقارير بيستخدموا نفس الدوال)
--    gross_sales  = مجموع إجمالي الفواتير المكتملة (بعد الخصم) — بيتحسب مرة واحدة لكل فاتورة
--    returns_total= المرتجعات المسجلة في الفترة على فواتير مكتملة
--    net_sales    = gross_sales − returns_total
--    الفواتير الملغاة (وكل مرتجعاتها) بره الحساب. الأيام بتتحدد بالتوقيت المحلي للصيدلية.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION report_sales_summary(p_from DATE, p_to DATE)
RETURNS TABLE (
  gross_sales NUMERIC, returns_total NUMERIC, net_sales NUMERIC, net_profit NUMERIC,
  invoice_count BIGINT, returns_count BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH rng AS (
    SELECT (p_from::timestamp AT TIME ZONE pharmacy_tz()) AS t_from,
           ((p_to + 1)::timestamp AT TIME ZONE pharmacy_tz()) AS t_to
  ),
  inv AS (
    SELECT si.id, si.total,
           COALESCE((SELECT SUM(it.cost_price_unit_snapshot * it.quantity_units)
                     FROM sale_items it WHERE it.invoice_id = si.id), 0) AS cogs
    FROM sale_invoices si, rng
    WHERE si.status = 'completed' AND si.created_at >= rng.t_from AND si.created_at < rng.t_to
  ),
  ret AS (
    SELECT r.refund_amount, r.cost_recovered
    FROM returns r
    JOIN sale_invoices si ON si.id = r.invoice_id AND si.status = 'completed', rng
    WHERE r.created_at >= rng.t_from AND r.created_at < rng.t_to
  )
  SELECT g.gs, r.rt, g.gs - r.rt, g.gp - r.rp, g.n, r.n
  FROM (SELECT COALESCE(SUM(total), 0) AS gs, COALESCE(SUM(total - cogs), 0) AS gp, COUNT(*) AS n FROM inv) g,
       (SELECT COALESCE(SUM(refund_amount), 0) AS rt,
               COALESCE(SUM(refund_amount - cost_recovered), 0) AS rp, COUNT(*) AS n FROM ret) r
$$;

CREATE OR REPLACE FUNCTION report_sales_daily(p_from DATE, p_to DATE)
RETURNS TABLE (
  day DATE, gross_sales NUMERIC, returns_total NUMERIC, net_sales NUMERIC, net_profit NUMERIC, invoice_count BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH rng AS (
    SELECT (p_from::timestamp AT TIME ZONE pharmacy_tz()) AS t_from,
           ((p_to + 1)::timestamp AT TIME ZONE pharmacy_tz()) AS t_to
  ),
  inv AS (
    SELECT pharmacy_date(si.created_at) AS d, si.total,
           COALESCE((SELECT SUM(it.cost_price_unit_snapshot * it.quantity_units)
                     FROM sale_items it WHERE it.invoice_id = si.id), 0) AS cogs
    FROM sale_invoices si, rng
    WHERE si.status = 'completed' AND si.created_at >= rng.t_from AND si.created_at < rng.t_to
  ),
  inv_d AS (SELECT d, SUM(total) AS gs, SUM(total - cogs) AS gp, COUNT(*) AS n FROM inv GROUP BY d),
  ret_d AS (
    SELECT pharmacy_date(r.created_at) AS d, SUM(r.refund_amount) AS rt, SUM(r.refund_amount - r.cost_recovered) AS rp
    FROM returns r
    JOIN sale_invoices si ON si.id = r.invoice_id AND si.status = 'completed', rng
    WHERE r.created_at >= rng.t_from AND r.created_at < rng.t_to
    GROUP BY 1
  )
  SELECT COALESCE(i.d, r.d), COALESCE(i.gs, 0), COALESCE(r.rt, 0),
         COALESCE(i.gs, 0) - COALESCE(r.rt, 0), COALESCE(i.gp, 0) - COALESCE(r.rp, 0), COALESCE(i.n, 0)
  FROM inv_d i FULL JOIN ret_d r ON r.d = i.d
  ORDER BY 1
$$;

CREATE OR REPLACE FUNCTION report_top_medicines(p_from DATE, p_to DATE, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (name TEXT, units_sold BIGINT, revenue NUMERIC)
LANGUAGE sql STABLE AS $$
  WITH rng AS (
    SELECT (p_from::timestamp AT TIME ZONE pharmacy_tz()) AS t_from,
           ((p_to + 1)::timestamp AT TIME ZONE pharmacy_tz()) AS t_to
  ),
  inv AS (
    SELECT si.id, si.total,
           (SELECT SUM(x.total) FROM sale_items x WHERE x.invoice_id = si.id) AS subtotal
    FROM sale_invoices si, rng
    WHERE si.status = 'completed' AND si.created_at >= rng.t_from AND si.created_at < rng.t_to
  )
  SELECT it.medicine_name_snapshot,
         SUM(it.quantity_units - COALESCE(rt.units, 0))::bigint,
         SUM(ROUND(it.total * CASE WHEN inv.subtotal > 0 THEN inv.total / inv.subtotal ELSE 1 END, 2) - COALESCE(rt.amt, 0))
  FROM sale_items it
  JOIN inv ON inv.id = it.invoice_id
  LEFT JOIN LATERAL (
    SELECT SUM(r.quantity_units) AS units, SUM(r.refund_amount) AS amt FROM returns r WHERE r.sale_item_id = it.id
  ) rt ON true
  GROUP BY it.medicine_name_snapshot
  ORDER BY 2 DESC, 1
  LIMIT p_limit
$$;

COMMIT;
