-- ============================================================================
-- db/migration_002_rollback.sql
-- التراجع عن سلوك migration_002 (والـ view بتاع migration_003) وإرجاع الدوال والـ triggers
-- القديمة من pharmacy_schema.sql. idempotent.
--
-- مهم:
--  * التراجع لازم يتم مع الرجوع للكود القديم (الكود الجديد بيعتمد على الدوال دي).
--  * الجداول والأعمدة الجديدة (sale_item_batches, stock_movements, stock_adjustments,
--    cash_movements, وأعمدة status/shift_id/... ) بتفضل كما هي عشان مفيش بيانات تتحذف.
--    لو عايز تحذفها فعلاً، شوف الجزء الاختياري في آخر الملف (متعلّق بالتعليق).
--  * الفواتير اللي اتلغت (status='voided') بتفضل في الجدول بحالتها؛ الكود القديم مبيعرفش الحالة،
--    فراجعها يدويًا قبل التراجع.
--  * لو حصلت مبيعات بعد التحديث، المخزون (stock_units) = مجموع التشغيلات لحد التراجع، وبعدها
--    السلوك القديم (stock_units بتتعدل بالـ triggers القديمة).
-- ============================================================================
BEGIN;

-- 1) شيل الحماية والمزامنة الجديدة
DROP TRIGGER IF EXISTS trg_guard_stock_units ON medicines;
DROP TRIGGER IF EXISTS trg_batches_sync_stock ON batches;
DROP TRIGGER IF EXISTS trg_protect_sale_items ON sale_items;
DROP TRIGGER IF EXISTS trg_protect_sale_invoices ON sale_invoices;
DROP TRIGGER IF EXISTS trg_deduct_stock_fefo ON sale_items;
DROP TRIGGER IF EXISTS trg_restock_on_return ON returns;

-- 2) القيود الجديدة (كانت NOT VALID)
ALTER TABLE sale_invoices DROP CONSTRAINT IF EXISTS chk_invoice_status;
ALTER TABLE sale_invoices DROP CONSTRAINT IF EXISTS chk_invoice_total_nonneg;
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS chk_sale_items_qty;
ALTER TABLE medicines DROP CONSTRAINT IF EXISTS chk_medicines_stock_nonneg;
ALTER TABLE batches DROP CONSTRAINT IF EXISTS chk_batches_qty_nonneg;
ALTER TABLE returns DROP CONSTRAINT IF EXISTS chk_returns_refund_method;

-- 3) رجّع الدوال القديمة (نفس تعريفات pharmacy_schema.sql)
CREATE OR REPLACE FUNCTION apply_new_batch()
RETURNS TRIGGER AS $$
DECLARE
  old_stock INTEGER;
  old_cost NUMERIC(12,2);
BEGIN
  SELECT stock_units, cost_price_unit INTO old_stock, old_cost
  FROM medicines WHERE id = NEW.medicine_id FOR UPDATE;

  UPDATE medicines
  SET stock_units = stock_units + NEW.received_units,
      cost_price_unit = CASE
        WHEN (COALESCE(old_stock,0) + NEW.received_units) > 0 THEN
          ROUND(((COALESCE(old_stock,0) * COALESCE(old_cost,0)) + (NEW.received_units * NEW.cost_price_unit))
                / (COALESCE(old_stock,0) + NEW.received_units), 2)
        ELSE NEW.cost_price_unit
      END
  WHERE id = NEW.medicine_id;

  IF NEW.quantity_units IS NULL OR NEW.quantity_units = 0 THEN
    NEW.quantity_units := NEW.received_units;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION compute_quantity_units()
RETURNS TRIGGER AS $$
DECLARE
  ups INTEGER;
  spb INTEGER;
BEGIN
  SELECT units_per_strip, strips_per_box INTO ups, spb
  FROM medicines WHERE id = NEW.medicine_id;

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

CREATE OR REPLACE FUNCTION deduct_stock_fefo()
RETURNS TRIGGER AS $$
DECLARE
  remaining INTEGER := NEW.quantity_units;
  b RECORD;
  take INTEGER;
  weighted_cost NUMERIC(14,4) := 0;
  current_stock INTEGER;
BEGIN
  SELECT stock_units INTO current_stock FROM medicines WHERE id = NEW.medicine_id FOR UPDATE;

  IF current_stock IS NULL OR current_stock < NEW.quantity_units THEN
    RAISE EXCEPTION 'المخزون غير كافٍ للصنف رقم % (المتاح: %، المطلوب: %)',
      NEW.medicine_id, COALESCE(current_stock,0), NEW.quantity_units;
  END IF;

  FOR b IN
    SELECT id, quantity_units, cost_price_unit
    FROM batches
    WHERE medicine_id = NEW.medicine_id AND quantity_units > 0
    ORDER BY expiry_date ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN remaining <= 0;
    take := LEAST(b.quantity_units, remaining);
    UPDATE batches SET quantity_units = quantity_units - take WHERE id = b.id;
    weighted_cost := weighted_cost + (take * b.cost_price_unit);
    remaining := remaining - take;
  END LOOP;

  IF remaining > 0 THEN
    weighted_cost := weighted_cost + (remaining * (SELECT cost_price_unit FROM medicines WHERE id = NEW.medicine_id));
  END IF;

  NEW.cost_price_unit_snapshot := ROUND(weighted_cost / NEW.quantity_units, 4);

  UPDATE medicines SET stock_units = stock_units - NEW.quantity_units WHERE id = NEW.medicine_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_deduct_stock_fefo
BEFORE INSERT ON sale_items
FOR EACH ROW
EXECUTE FUNCTION deduct_stock_fefo();

CREATE OR REPLACE FUNCTION refresh_invoice_total()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sale_invoices
  SET total = (SELECT COALESCE(SUM(total), 0) FROM sale_items WHERE invoice_id = NEW.invoice_id) - COALESCE(discount, 0)
  WHERE id = NEW.invoice_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION restock_on_return()
RETURNS TRIGGER AS $$
DECLARE
  b_id INTEGER;
BEGIN
  IF NEW.restocked AND NEW.medicine_id IS NOT NULL THEN
    UPDATE medicines SET stock_units = stock_units + NEW.quantity_units WHERE id = NEW.medicine_id;

    SELECT id INTO b_id FROM batches
    WHERE medicine_id = NEW.medicine_id AND expiry_date >= CURRENT_DATE
    ORDER BY expiry_date DESC LIMIT 1;

    IF b_id IS NOT NULL THEN
      UPDATE batches SET quantity_units = quantity_units + NEW.quantity_units WHERE id = b_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_restock_on_return
AFTER INSERT ON returns
FOR EACH ROW
EXECUTE FUNCTION restock_on_return();

-- 4) الـ views القديمة (CURRENT_DATE) و v_stock_batch_mismatch
CREATE OR REPLACE VIEW near_expiry_batches AS
SELECT b.id AS batch_id, m.id AS medicine_id, m.name, b.batch_number,
       b.expiry_date, b.quantity_units,
       (b.expiry_date - CURRENT_DATE) AS days_left
FROM batches b
JOIN medicines m ON m.id = b.medicine_id
WHERE b.quantity_units > 0
  AND b.expiry_date <= (CURRENT_DATE + INTERVAL '90 days')
ORDER BY b.expiry_date ASC;
DROP VIEW IF EXISTS v_stock_batch_mismatch;

-- 5) الدوال الجديدة (كود بس، مفيهاش بيانات)
DROP FUNCTION IF EXISTS finalize_sale_invoice(INTEGER, NUMERIC, INTEGER);
DROP FUNCTION IF EXISTS void_sale_invoice(INTEGER, INTEGER, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_return(INTEGER, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS adjust_medicine_stock(INTEGER, INTEGER, TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS shift_summary(INTEGER);
DROP FUNCTION IF EXISTS record_shift_cash(INTEGER, INTEGER, TEXT, TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS close_shift(INTEGER, INTEGER, TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS report_sales_summary(DATE, DATE);
DROP FUNCTION IF EXISTS report_sales_daily(DATE, DATE);
DROP FUNCTION IF EXISTS report_top_medicines(DATE, DATE, INTEGER);
DROP FUNCTION IF EXISTS guard_stock_units();
DROP FUNCTION IF EXISTS batches_sync_stock();
DROP FUNCTION IF EXISTS protect_sale_items();
DROP FUNCTION IF EXISTS protect_sale_invoices();
DROP FUNCTION IF EXISTS audit_event(INTEGER, TEXT, TEXT, TEXT, TEXT, JSONB);
-- (pharmacy_tz / pharmacy_today / pharmacy_date بنسيبهم: ملهمش تأثير وممكن يكونوا مستخدمين)

COMMIT;

-- ----------------------------------------------------------------------------
-- اختياري (احذف التعليق لو متأكد إنك مش محتاج السجلات الجديدة — بيمسح بيانات!):
-- DROP TABLE IF EXISTS sale_item_batches, stock_movements, stock_adjustments, cash_movements CASCADE;
-- ----------------------------------------------------------------------------
