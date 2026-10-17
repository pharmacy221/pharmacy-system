-- db/migration_forms.sql
-- شغّله مرة واحدة في Supabase SQL Editor (أو هيتشغل تلقائي مع: npm run import-inventory)
-- بيضيف "نوع المنتج" ووحدات البيع، ويجهّز الجداول لاستيراد دليل الأدوية كله في المخزون.

-- نوع المنتج: tablet / capsule / injection / spray / syrup / cream ... (شوف lib/drug-form.js)
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS form_kind TEXT;
-- ربط الصنف بصف دليل الأدوية (يمنع التكرار لو شغّلت الاستيراد أكتر من مرة)
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS ref_id INTEGER;

-- أعمدة بيستخدمها كود صفحة الأصناف (لو مش موجودة عندك لسه)
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS serial_number TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS conditions_tags TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS min_age_years NUMERIC;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS max_age_years NUMERIC;

-- اسم الوحدة وقت البيع (حقنة / شراب / حبة / شريط / علبة...) محفوظ على الفاتورة والمرتجع
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_label TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS unit_label TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_medicines_ref_id ON medicines (ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medicines_form_kind ON medicines (form_kind);
CREATE INDEX IF NOT EXISTS idx_medicines_active_name ON medicines (lower(name)) WHERE is_active = true;

-- بحث سريع بالاسم (جزء من الكلمة) على 25 ألف صنف
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_medicines_name_trgm ON medicines USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_medicines_generic_trgm ON medicines USING gin (generic_name gin_trgm_ops);
