-- ============================================================================
-- db/migration_010_shortcut_sizes.sql
-- 1) كلمة اختصار للصنف (shortcut_code): في الكاشير لما تكتبها وتدوس Enter الصنف بيتضاف للفاتورة علطول.
-- 2) مقاسات الأصناف (سرنجات / حفاظات / ...): الأصناف اللي ليها نفس size_group بتتنقل بينها بالأسهم في الكاشير
--    size_label = اسم المقاس (5 مل / L)، size_order = ترتيب المقاس (الأصغر رقم أصغر).
-- آمن لإعادة التشغيل. مفيش أي بيانات قديمة بتتغير.
-- ============================================================================
BEGIN;

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS shortcut_code TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS size_group TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS size_label TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS size_order NUMERIC(10,2);

-- نفس الكلمة ماتتكررش لصنفين (بدون حساسية لحالة الحروف)
CREATE UNIQUE INDEX IF NOT EXISTS uq_medicines_shortcut_code ON medicines (lower(shortcut_code)) WHERE shortcut_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medicines_size_group ON medicines (lower(size_group)) WHERE size_group IS NOT NULL;

COMMIT;
