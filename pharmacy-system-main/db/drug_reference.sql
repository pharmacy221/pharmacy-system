-- db/drug_reference.sql
-- جدول مرجعي للأدوية المصرية (للبحث فقط) - منفصل تمامًا عن جدول medicines (مخزونك).
-- شغّله مرة واحدة في Supabase SQL Editor، وبعدها شغّل:  npm run import-drugs
CREATE TABLE IF NOT EXISTS drug_reference (
  id SERIAL PRIMARY KEY,
  name_en TEXT NOT NULL,        -- الاسم التجاري بالإنجليزي (بيشمل الحجم/الشكل)
  name_ar TEXT,                 -- الاسم التجاري بالعربي
  scientific_name TEXT,         -- المادة الفعالة
  manufacturer TEXT,
  drug_class TEXT,              -- التصنيف العلاجي
  route TEXT,                   -- طريقة الاستخدام
  price_egp NUMERIC(12,2)       -- سعر العلبة (جنيه)
);

ALTER TABLE drug_reference ADD COLUMN IF NOT EXISTS barcode TEXT;  -- باركود العلبة الأصلي (لو المصدر فيه)

CREATE INDEX IF NOT EXISTS idx_drug_ref_sci ON drug_reference (scientific_name);
CREATE INDEX IF NOT EXISTS idx_drug_ref_name_en ON drug_reference (lower(name_en));

-- نفس سياسة باقي الجداول في Supabase
ALTER TABLE drug_reference ENABLE ROW LEVEL SECURITY;
