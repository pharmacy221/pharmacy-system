-- ============================================================================
-- db/migration_011_addons.sql
-- المستلزمات المرتبطة بالأصناف (سرنجات / قطن / كحول / كانيولا / طقم محلول ...)
--
-- الفكرة:
--  1) جدول medicine_addons: كل صف = "الصنف ده ليه المستلزم ده".
--       auto_add        = true  → يتضاف للفاتورة علطول أول ما تختار الصنف (زي السرنجة)
--       default_checked = true  → يظهر في قائمة الاقتراحات ومعلّم مسبقًا
--       qty_units       = الكمية (بوحدة المستلزم الأساسية)
--  2) المستلزمات نفسها أصناف عادية في جدول medicines (فبتتباع وتتخصم من المخزون FEFO زي أي صنف).
--  3) الدالة rebuild_addons() بتربط كل الحقن والمحاليل الوريدية اللي عندك تلقائيًا:
--       - الحقنة: سرنجة بالحجم المناسب (من حجم الأمبولة في الاسم) + سواب كحول + بلاستر
--       - الفيال البودرة: سرنجة 5 مل + ماء مقطر
--       - الأنسولين: سرنجة أنسولين
--       - المحلول الوريدي: طقم محلول + كانيولا + لاصق كانيولا + سواب كحول
--     وبتتجاهل أي ربط عدّلته إنت يدويًا (is_manual = true).
-- آمن لإعادة التشغيل. مفيش أي بيانات قديمة بتتغير.
-- الأسعار هنا افتراضية: عدّلها من صفحة الأصناف.
-- ============================================================================
BEGIN;

-- ---------- 1) جدول الربط ----------
CREATE TABLE IF NOT EXISTS medicine_addons (
  id SERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  addon_id    INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  qty_units   INTEGER NOT NULL DEFAULT 1 CHECK (qty_units >= 1),
  auto_add        BOOLEAN NOT NULL DEFAULT false,
  default_checked BOOLEAN NOT NULL DEFAULT true,
  label       TEXT,                       -- سبب الاقتراح (يظهر للكاشير): "للحقن العضل" ...
  sort_order  INTEGER NOT NULL DEFAULT 100,
  is_manual   BOOLEAN NOT NULL DEFAULT false,   -- true = إنت ضفته/عدّلته بإيدك، rebuild_addons() مش هيلمسه
  created_at  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_addon_not_self CHECK (medicine_id <> addon_id),
  CONSTRAINT uq_medicine_addon UNIQUE (medicine_id, addon_id)
);
CREATE INDEX IF NOT EXISTS idx_medicine_addons_medicine ON medicine_addons (medicine_id, sort_order);

-- ---------- 2) المستلزمات (أصناف عادية) ----------
-- كل مستلزم له shortcut_code عشان تلاقيه بسرعة في الكاشير بالكتابة + Enter.
-- السرنجات ليها size_group واحد 'سرنجة' فبتتنقل بينها بالأسهم ↑ ↓ في الكاشير.
INSERT INTO medicines (name, category, dosage_form, form_kind, units_per_strip, strips_per_box,
                       sale_price_unit, sale_price_strip, sale_price_box, min_stock_units, shortcut_code, size_group, size_label, size_order)
SELECT v.name, 'مستلزمات طبية', 'مستلزم', 'other', 1, 1, v.price, NULL, NULL, v.min_stock, v.code, v.sgroup, v.slabel, v.sorder
FROM (VALUES
  ('سرنجة 1 مل (أنسولين)',  3.00, 50, 'sr1',  'سرنجة', '1 مل',  1),
  ('سرنجة 3 مل',            2.50, 100, 'sr3',  'سرنجة', '3 مل',  3),
  ('سرنجة 5 مل',            3.00, 100, 'sr5',  'سرنجة', '5 مل',  5),
  ('سرنجة 10 مل',           4.00, 50,  'sr10', 'سرنجة', '10 مل', 10),
  ('سرنجة 20 مل',           6.00, 20,  'sr20', 'سرنجة', '20 مل', 20),
  ('سواب كحول',             1.00, 100, 'swab', NULL, NULL, NULL),
  ('بلاستر جروح',           1.00, 100, 'plst', NULL, NULL, NULL),
  ('قطن (لفة صغيرة)',      10.00, 10,  'qutn', NULL, NULL, NULL),
  ('ماء مقطر للحقن (أمبولة 5 مل)', 3.00, 50, 'dw5', NULL, NULL, NULL),
  ('طقم محلول (IV Set)',    8.00, 30,  'ivset', NULL, NULL, NULL),
  ('كانيولا 22',           10.00, 30,  'can22', 'كانيولا', '22', 22),
  ('كانيولا 20',           10.00, 30,  'can20', 'كانيولا', '20', 20),
  ('كانيولا 24',           10.00, 30,  'can24', 'كانيولا', '24', 24),
  ('لاصق كانيولا',          3.00, 30,  'fixa', NULL, NULL, NULL),
  ('قفاز طبي (زوج)',        2.00, 50,  'glv',  NULL, NULL, NULL)
) AS v(name, price, min_stock, code, sgroup, slabel, sorder)
WHERE NOT EXISTS (SELECT 1 FROM medicines m WHERE lower(m.name) = lower(v.name))
  AND NOT EXISTS (SELECT 1 FROM medicines m WHERE lower(m.shortcut_code) = lower(v.code));

-- ---------- 3) تعريف "سرنجة المستلزم" بالاسم (عشان الدالة تلاقيهم حتى لو غيّرت الـ id) ----------
-- بنستخدم shortcut_code كمفتاح ثابت للمستلزمات الأساسية.
CREATE OR REPLACE FUNCTION addon_id_by_code(p_code TEXT) RETURNS INTEGER AS $$
  SELECT id FROM medicines WHERE lower(shortcut_code) = lower(p_code) AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE;

-- حجم الأمبولة بالمل من الاسم (مثلاً "2 ML" أو "5ML" أو "0.5 ML") — NULL لو مش مكتوب
CREATE OR REPLACE FUNCTION parse_volume_ml(p_name TEXT) RETURNS NUMERIC AS $$
  SELECT NULLIF(substring(upper(p_name) FROM '(\d+(?:\.\d+)?)\s*ML'), '')::numeric;
$$ LANGUAGE sql IMMUTABLE;

-- ---------- 4) ربط كل الأصناف تلقائيًا ----------
-- بتمسح الربط التلقائي القديم (is_manual = false) وتبنيه من جديد حسب القواعد دي.
-- شغّلها تاني (SELECT rebuild_addons();) أي وقت تضيف أصناف جديدة.
CREATE OR REPLACE FUNCTION rebuild_addons() RETURNS INTEGER AS $$
DECLARE
  n INTEGER;
  c_sr1  INTEGER := addon_id_by_code('sr1');
  c_sr3  INTEGER := addon_id_by_code('sr3');
  c_sr5  INTEGER := addon_id_by_code('sr5');
  c_sr10 INTEGER := addon_id_by_code('sr10');
  c_swab INTEGER := addon_id_by_code('swab');
  c_plst INTEGER := addon_id_by_code('plst');
  c_dw5  INTEGER := addon_id_by_code('dw5');
  c_ivset INTEGER := addon_id_by_code('ivset');
  c_can22 INTEGER := addon_id_by_code('can22');
  c_fixa  INTEGER := addon_id_by_code('fixa');
BEGIN
  DELETE FROM medicine_addons WHERE is_manual = false;

  -- (أ) كل الحقن (form_kind = injection أو الشكل مكتوب "حقن")، ما عدا المستلزمات نفسها
  CREATE TEMP TABLE _inj ON COMMIT DROP AS
  SELECT m.id,
         parse_volume_ml(m.name) AS vol,
         (upper(m.name) ~ '(PEN|FLEXPEN|FLEXTOUCH|KWIKPEN|SOLOSTAR|CARTRIDGE|PREFILLED|PRE-FILLED|PFS|AUTO ?INJ)') AS prefilled,
         (upper(m.name) ~ '(INSULIN|ANTISULIN|MIXTARD|LANTUS|NOVORAPID|HUMALOG|HUMULIN|LEVEMIR|TRESIBA|ACTRAPID)') AS insulin,
         (upper(m.name) ~ '(VIAL|POWDER|LYOPH|DRY SUB|FOR INJ)' AND upper(m.name) !~ 'AMP') AS vial_powder
  FROM medicines m
  WHERE m.is_active = true
    AND COALESCE(m.dosage_form, '') <> 'مستلزم'
    AND (m.form_kind = 'injection' OR m.dosage_form ILIKE '%حقن%');

  -- سرنجة بالحجم المناسب — بتتضاف علطول (auto_add)
  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT i.id,
         CASE
           WHEN i.insulin           THEN c_sr1
           WHEN i.vial_powder       THEN c_sr5
           WHEN i.vol >= 10         THEN c_sr10
           WHEN i.vol >= 5          THEN c_sr5
           ELSE c_sr3
         END,
         1, true, true,
         CASE WHEN i.insulin THEN 'سرنجة أنسولين' WHEN i.vial_powder THEN 'سرنجة لتحضير الفيال' ELSE 'سرنجة للحقنة' END,
         10
  FROM _inj i
  WHERE NOT i.prefilled   -- الأقلام والسرنجات المعبأة جاهزة، مش محتاجة سرنجة
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  -- ماء مقطر للفيالات البودرة (اقتراح مش إجباري)
  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT i.id, c_dw5, 1, false, true, 'مذيب للفيال', 20
  FROM _inj i WHERE i.vial_powder AND NOT i.prefilled AND NOT i.insulin AND c_dw5 IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  -- سواب كحول + بلاستر لكل حقنة (اقتراح)
  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT i.id, c_swab, 1, false, true, 'تعقيم مكان الحقن', 30 FROM _inj i WHERE c_swab IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT i.id, c_plst, 1, false, false, 'بلاستر بعد الحقن', 40 FROM _inj i WHERE c_plst IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  -- (ب) المحاليل الوريدية: طقم محلول (علطول) + كانيولا + لاصق + سواب (اقتراحات)
  CREATE TEMP TABLE _inf ON COMMIT DROP AS
  SELECT m.id FROM medicines m
  WHERE m.is_active = true AND COALESCE(m.dosage_form, '') <> 'مستلزم'
    AND (m.form_kind = 'infusion' OR m.dosage_form ILIKE '%محلول وريدي%');

  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT f.id, c_ivset, 1, true, true, 'طقم تركيب المحلول', 10 FROM _inf f WHERE c_ivset IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT f.id, c_can22, 1, false, true, 'كانيولا', 20 FROM _inf f WHERE c_can22 IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT f.id, c_fixa, 1, false, true, 'لاصق تثبيت الكانيولا', 30 FROM _inf f WHERE c_fixa IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  INSERT INTO medicine_addons (medicine_id, addon_id, qty_units, auto_add, default_checked, label, sort_order)
  SELECT f.id, c_swab, 1, false, true, 'تعقيم', 40 FROM _inf f WHERE c_swab IS NOT NULL
  ON CONFLICT (medicine_id, addon_id) DO NOTHING;

  DROP TABLE IF EXISTS _inj;
  DROP TABLE IF EXISTS _inf;

  SELECT count(*) INTO n FROM medicine_addons;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

SELECT rebuild_addons();

COMMIT;
