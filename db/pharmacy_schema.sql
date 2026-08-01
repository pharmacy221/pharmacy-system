-- ============================================================
-- Pharmacy Management System — Supabase / PostgreSQL Schema
-- تحويل نظام محل الموبايلات إلى نظام صيدلية متكامل
-- شغّل الملف ده كامل في: Supabase Dashboard > SQL Editor > New Query
-- ملاحظة مهمة: ده شغال على قاعدة بيانات فاضية جديدة.
-- لو هتشغله على نفس مشروع Supabase القديم، اعمل DROP للجداول
-- القديمة الغير مطلوبة (شوف قسم "تنظيف" في آخر الملف).
-- ============================================================

-- ------------------------------------------------------------
-- 1) المستخدمين (أدمن / صيدلي / كاشير)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'pharmacist' CHECK (role IN ('admin', 'pharmacist', 'cashier')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 2) الموردين (شركات / وكلاء الأدوية)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 3) الأصناف (الدواء / المستحضر / المكمل الغذائي...)
-- التسعير والمخزون متتبَّع بوحدة "الحبة/القطعة" كوحدة أساسية،
-- والبيع ممكن يتم بالحبة أو بالشريط أو بالعلبة حسب الإعدادات هنا.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medicines (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,                     -- الاسم التجاري
  generic_name TEXT,                      -- الاسم العلمي (المادة الفعالة)
  category TEXT DEFAULT 'أدوية',          -- أدوية / مستحضرات تجميل / مكملات غذائية / أدوات طبية / رضاعة وأطفال ...
  dosage_form TEXT,                       -- أقراص / شراب / كبسول / حقن / كريم / قطرة / بخاخ ...
  manufacturer TEXT,
  barcode TEXT UNIQUE,

  requires_prescription BOOLEAN DEFAULT false,  -- يحتاج روشتة
  controlled_substance BOOLEAN DEFAULT false,    -- خاضع للرقابة (يستلزم تسجيل بيانات إضافية عند البيع)

  units_per_strip INTEGER DEFAULT 1 CHECK (units_per_strip >= 1),  -- عدد الحبات في الشريط
  strips_per_box INTEGER DEFAULT 1 CHECK (strips_per_box >= 1),    -- عدد الشرائط في العلبة

  sale_price_unit NUMERIC(12,2) NOT NULL DEFAULT 0,   -- سعر بيع الحبة الواحدة
  sale_price_strip NUMERIC(12,2),                      -- سعر بيع الشريط (لو NULL يتحسب تلقائي = سعر الحبة × عدد الحبات)
  sale_price_box NUMERIC(12,2),                        -- سعر بيع العلبة كاملة (اختياري)

  cost_price_unit NUMERIC(12,2) DEFAULT 0,   -- متوسط سعر تكلفة الحبة (بيتحدّث من التشغيلات)

  stock_units INTEGER NOT NULL DEFAULT 0,    -- إجمالي المخزون الفعلي بالحبة (المرجع الوحيد للجرد)
  min_stock_units INTEGER DEFAULT 10,        -- حد الطلب الأدنى بالحبة (تنبيه نواقص)

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_medicines_updated_at ON medicines;
CREATE TRIGGER trg_medicines_updated_at
BEFORE UPDATE ON medicines
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- تحسب سعر الشريط تلقائيًا لو مش متسعّر يدويًا
CREATE OR REPLACE FUNCTION default_strip_price()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sale_price_strip IS NULL THEN
    NEW.sale_price_strip := ROUND(NEW.sale_price_unit * NEW.units_per_strip, 2);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_medicines_default_strip_price ON medicines;
CREATE TRIGGER trg_medicines_default_strip_price
BEFORE INSERT OR UPDATE ON medicines
FOR EACH ROW
EXECUTE FUNCTION default_strip_price();

-- ------------------------------------------------------------
-- 4) التشغيلات / الباتشات (Batches) — أهم جدول في نظام الصيدليات
-- كل توريد جديد بيدخل هنا برقم تشغيلة وتاريخ صلاحية مستقل،
-- عشان نقدر نطبّق "الأقرب صلاحية يتصرف الأول" (FEFO) ونعمل
-- تنبيهات قرب انتهاء الصلاحية.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  batch_number TEXT,
  expiry_date DATE NOT NULL,
  quantity_units INTEGER NOT NULL DEFAULT 0,      -- الكمية المتبقية من التشغيلة (بالحبة)
  received_units INTEGER NOT NULL DEFAULT 0,      -- الكمية الأصلية وقت الاستلام (بالحبة، لا تتغير)
  cost_price_unit NUMERIC(12,2) NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batches_medicine ON batches (medicine_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches (expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_remaining ON batches (medicine_id, expiry_date) WHERE quantity_units > 0;

-- عند إضافة تشغيلة جديدة: نزوّد مخزون الصنف بالحبة، ونحدّث متوسط سعر التكلفة
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
      -- متوسط تكلفة مرجّح بالكمية
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

DROP TRIGGER IF EXISTS trg_apply_new_batch ON batches;
CREATE TRIGGER trg_apply_new_batch
BEFORE INSERT ON batches
FOR EACH ROW
EXECUTE FUNCTION apply_new_batch();

-- ------------------------------------------------------------
-- 5) فواتير البيع (رأس الفاتورة) — تجميع أكتر من صنف في عملية بيع واحدة
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_invoices (
  id SERIAL PRIMARY KEY,
  customer_name TEXT,
  customer_phone TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) DEFAULT 0,
  payment_method TEXT DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'other')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 6) بنود الفاتورة (كل صنف مباع وبأي وحدة: حبة / شريط / علبة)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES sale_invoices(id) ON DELETE CASCADE,
  medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
  medicine_name_snapshot TEXT,
  sale_unit TEXT NOT NULL DEFAULT 'unit' CHECK (sale_unit IN ('unit', 'strip', 'box')), -- حبة / شريط / علبة
  quantity INTEGER NOT NULL DEFAULT 1,          -- الكمية بنفس وحدة sale_unit (مثلاً: 2 شريط)
  quantity_units INTEGER NOT NULL,              -- نفس الكمية محوّلة لحبة (تُحسب تلقائيًا)
  unit_price NUMERIC(12,2) NOT NULL,            -- سعر الوحدة المختارة وقت البيع
  total NUMERIC(12,2) NOT NULL,
  cost_price_unit_snapshot NUMERIC(12,2) DEFAULT 0,  -- لقطة تكلفة الحبة وقت البيع (لحساب الربح تاريخيًا)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_items_invoice ON sale_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_medicine ON sale_items (medicine_id);

-- تحويل الكمية المباعة لوحدة "الحبة" تلقائيًا حسب sale_unit
CREATE OR REPLACE FUNCTION compute_quantity_units()
RETURNS TRIGGER AS $$
DECLARE
  ups INTEGER;      -- units_per_strip
  spb INTEGER;      -- strips_per_box
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

DROP TRIGGER IF EXISTS trg_compute_quantity_units ON sale_items;
CREATE TRIGGER trg_compute_quantity_units
BEFORE INSERT ON sale_items
FOR EACH ROW
EXECUTE FUNCTION compute_quantity_units();

-- خصم المخزون تلقائيًا بنظام FEFO (أقرب تشغيلة صلاحية تتصرف الأول)
-- + رفض البيع لو المخزون غير كافي
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

  -- لو الكمية المطلوبة أكبر من مجموع التشغيلات المسجلة (بيانات تشغيلات ناقصة)
  -- نكمّل الباقي بمتوسط تكلفة الصنف نفسه من غير ما نمنع البيع
  IF remaining > 0 THEN
    weighted_cost := weighted_cost + (remaining * (SELECT cost_price_unit FROM medicines WHERE id = NEW.medicine_id));
  END IF;

  NEW.cost_price_unit_snapshot := ROUND(weighted_cost / NEW.quantity_units, 4);

  UPDATE medicines SET stock_units = stock_units - NEW.quantity_units WHERE id = NEW.medicine_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deduct_stock_fefo ON sale_items;
CREATE TRIGGER trg_deduct_stock_fefo
BEFORE INSERT ON sale_items
FOR EACH ROW
EXECUTE FUNCTION deduct_stock_fefo();

-- تحديث إجمالي الفاتورة تلقائيًا كل ما يتضاف بند
CREATE OR REPLACE FUNCTION refresh_invoice_total()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE sale_invoices
  SET total = (SELECT COALESCE(SUM(total), 0) FROM sale_items WHERE invoice_id = NEW.invoice_id) - COALESCE(discount, 0)
  WHERE id = NEW.invoice_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refresh_invoice_total ON sale_items;
CREATE TRIGGER trg_refresh_invoice_total
AFTER INSERT ON sale_items
FOR EACH ROW
EXECUTE FUNCTION refresh_invoice_total();

-- ------------------------------------------------------------
-- 7) المرتجعات
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS returns (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES sale_invoices(id) ON DELETE SET NULL,
  medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
  medicine_name_snapshot TEXT,
  sale_unit TEXT DEFAULT 'unit' CHECK (sale_unit IN ('unit', 'strip', 'box')),
  quantity INTEGER NOT NULL DEFAULT 1,
  quantity_units INTEGER NOT NULL DEFAULT 1,
  refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  restocked BOOLEAN DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- إرجاع الكمية للمخزون (على أقرب تشغيلة صلاحية غير منتهية) لو restocked = true
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

DROP TRIGGER IF EXISTS trg_restock_on_return ON returns;
CREATE TRIGGER trg_restock_on_return
AFTER INSERT ON returns
FOR EACH ROW
EXECUTE FUNCTION restock_on_return();

-- ------------------------------------------------------------
-- 8) الشِفتات (فتح/قفل درج الكاش)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opening_balance NUMERIC(12,2) DEFAULT 0,
  closing_balance NUMERIC(12,2),
  opened_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- ------------------------------------------------------------
-- 9) سجل الأنشطة (تعديل/حذف/بيع...) لمتابعة حركة الموظفين
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 10) الكوبونات / الخصومات
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  discount_percent NUMERIC(5,2),
  discount_amount NUMERIC(12,2),
  active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 11) الإعدادات العامة
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ------------------------------------------------------------
-- 12) Views مفيدة لصاحب الصيدلية
-- ------------------------------------------------------------

-- أصناف تحت حد الطلب الأدنى
CREATE OR REPLACE VIEW low_stock_medicines AS
SELECT id, name, generic_name, stock_units, min_stock_units
FROM medicines
WHERE is_active = true AND stock_units <= min_stock_units;

-- تشغيلات قربت تنتهي (خلال 90 يوم) أو منتهية فعلاً
CREATE OR REPLACE VIEW near_expiry_batches AS
SELECT b.id AS batch_id, m.id AS medicine_id, m.name, b.batch_number,
       b.expiry_date, b.quantity_units,
       (b.expiry_date - CURRENT_DATE) AS days_left
FROM batches b
JOIN medicines m ON m.id = b.medicine_id
WHERE b.quantity_units > 0
  AND b.expiry_date <= (CURRENT_DATE + INTERVAL '90 days')
ORDER BY b.expiry_date ASC;

-- ------------------------------------------------------------
-- 13) Indexes عامة
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines (name);
CREATE INDEX IF NOT EXISTS idx_medicines_generic ON medicines (generic_name);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines (barcode);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON sale_invoices (created_at);

-- ------------------------------------------------------------
-- 14) Row Level Security — نفس منطق المشروع الأصلي:
-- السيرفر (Express) بيتكلم بـ service_role اللي بيتخطى RLS تلقائيًا،
-- فتفعيل RLS هنا غرضه منع أي وصول لو انكشف anon key بالغلط بس.
-- ------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicines ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- تنظيف: لو بتشغل الملف ده فوق قاعدة بيانات المحل القديمة،
-- شيل الجداول اللي مالهاش لازمة في الصيدلية (شغّلها قبل ما تنشئ
-- الجداول الجديدة، أو في transaction منفصل):
--
-- DROP TABLE IF EXISTS wallet_transactions CASCADE;
-- DROP TABLE IF EXISTS devices CASCADE;
-- DROP TABLE IF EXISTS line_labels CASCADE;
-- DROP TABLE IF EXISTS installments CASCADE;
-- DROP TABLE IF EXISTS installment_payments CASCADE;
-- DROP TABLE IF EXISTS maintenance_orders CASCADE;
-- DROP TABLE IF EXISTS inventory_items CASCADE;   -- IMEI (خاص بالموبايلات فقط)
-- DROP TABLE IF EXISTS commission_settings CASCADE;
-- DROP TABLE IF EXISTS api_keys CASCADE;
-- ============================================================

-- تم بنجاح ✅
