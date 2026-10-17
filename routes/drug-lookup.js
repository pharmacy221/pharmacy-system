// routes/drug-lookup.js
// البحث في دليل الأدوية المصرية (جدول drug_reference): بالاسم التجاري (عربي/إنجليزي) أو المادة الفعالة،
// مع عرض البدائل (نفس المادة الفعالة) وإضافة أي دواء لمخزونك بضغطة زر.
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { classifyDrug } = require('../lib/drug-form');

const router = express.Router();
router.use(requireLogin);

const LIMIT = 100;

// بيهرّب علامات % و _ و \ عشان تتعامل كنص عادي جوه ILIKE
const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

// توحيد الحروف العربية للبحث التقريبي: أ/إ/آ ← ا ، ى ← ي ، ة ← ه ، وبنشيل الألف خالص
// عشان "بنادول" تلاقي "بانادول" (الكتابة في الداتا مش دايمًا زي ما الناس بتكتب)
const SQL_FOLD = (col) => `replace(translate(${col}, 'أإآىة', 'اايه'), 'ا', '')`;
const foldAr = (t) => t.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ا/g, '');

// ميزة: كل كلمة بيكتبها المستخدم لازم تتلاقي في (الاسم الإنجليزي أو العربي أو المادة الفعالة)
// فـ "بنادول 500" أو "paracetamol 500" يشتغلوا حتى لو الكلمات في أماكن مختلفة
async function searchReference({ q, alt, fuzzy = false }) {
  const base = `
    SELECT d.*, inv.id AS inv_id, inv.stock_units
    FROM drug_reference d
    LEFT JOIN LATERAL (
      SELECT m.id, m.stock_units FROM medicines m
      WHERE m.is_active = true AND lower(m.name) = lower(d.name_en)
      LIMIT 1
    ) inv ON true`;

  if (alt) {
    return query(`${base} WHERE d.scientific_name = $1 ORDER BY d.price_egp ASC NULLS LAST, d.name_en LIMIT 300`, [alt]);
  }

  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  const params = [];
  const where = terms.map((t) => {
    if (fuzzy) {
      params.push(`%${escapeLike(foldAr(t))}%`);
      const p = `$${params.length}`;
      return `(${SQL_FOLD('d.name_ar')} ILIKE ${p} OR d.name_en ILIKE ${p} OR d.scientific_name ILIKE ${p})`;
    }
    params.push(`%${escapeLike(t)}%`);
    const p = `$${params.length}`;
    return `(d.name_en ILIKE ${p} OR d.name_ar ILIKE ${p} OR d.scientific_name ILIKE ${p})`;
  });
  params.push(`${escapeLike(q)}%`);
  const prefix = `$${params.length}`;
  return query(
    `${base} WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN d.name_en ILIKE ${prefix} OR d.name_ar ILIKE ${prefix} THEN 0 ELSE 1 END, lower(d.name_en)
     LIMIT ${LIMIT}`,
    params
  );
}

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const alt = (req.query.alt || '').trim();
    let results = [];
    let notReady = false;
    let approx = false;

    if (q || alt) {
      try {
        results = await searchReference({ q, alt });
        // مفيش تطابق حرفي؟ جرّب بحث تقريبي (للعربي أساسًا)
        if (!results.length && q && /[\u0600-\u06FF]/.test(q)) {
          results = await searchReference({ q, fuzzy: true });
          approx = results.length > 0;
        }
      } catch (err) {
        // 42P01 = الجدول لسه متعملش (لسه ماشغلتش db/drug_reference.sql و npm run import-drugs)
        if (err.code === '42P01') notReady = true;
        else throw err;
      }
    }

    // نضيف شكل الدواء (زجاجة/علبة/شريط) لكل نتيجة عشان الواجهة تعرض الوحدة الصح
    results = results.map((d) => ({ ...d, form: classifyDrug(d) }));

    res.render('drug-lookup', {
      q, alt, results, notReady, approx, limit: LIMIT,
      msg: req.query.msg || '',
      canAdd: req.session.role === 'admin',
      active: 'drug-lookup'
    });
  } catch (err) {
    next(err);
  }
});

// ============ إضافة دواء من الدليل لمخزونك ============
// السعر بيتجاب من الداتابيز مش من الفورم (عشان محدش يعدّل السعر من المتصفح)
router.post('/add', requireAdmin, async (req, res, next) => {
  try {
    const refId = parseInt(req.body.ref_id);
    const ref = Number.isInteger(refId) ? await queryOne('SELECT * FROM drug_reference WHERE id = $1', [refId]) : null;
    if (!ref) return res.redirect('/drug-lookup?msg=notfound');

    // الشكل ووحدات البيع بتتحدد من السيرفر حسب اسم الدواء (قرص/كبسول/حقنة/بخاخة/شراب...)
    const form = classifyDrug(ref);
    const unitsPerStrip = form.countable ? Math.max(parseInt(req.body.units_per_strip) || form.unitsPerStrip, 1) : 1;
    const stripsPerBox = form.countable ? Math.max(parseInt(req.body.strips_per_box) || form.stripsPerBox, 1) : 1;
    const barcode = (req.body.barcode || ref.barcode || '').trim() || null;

    const existing = await queryOne('SELECT id FROM medicines WHERE is_active = true AND lower(name) = lower($1)', [ref.name_en]);
    if (existing) return res.redirect('/products?q=' + encodeURIComponent(ref.name_en));

    const box = ref.price_egp || 0;
    const perStrip = Math.round((box / stripsPerBox) * 100) / 100;
    const perUnit = Math.round((box / (unitsPerStrip * stripsPerBox)) * 100) / 100;

    try {
      await query(
        `INSERT INTO medicines (name, generic_name, category, dosage_form, form_kind, manufacturer, barcode, units_per_strip, strips_per_box,
                                sale_price_unit, sale_price_strip, sale_price_box, stock_units, ref_id)
         VALUES ($1, $2, 'أدوية', $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12)`,
        [ref.name_en, ref.scientific_name, form.dosageForm, form.kind, ref.manufacturer, barcode, unitsPerStrip, stripsPerBox, perUnit, perStrip, box, ref.id]
      );
    } catch (err) {
      if (err.code === '23505') return res.redirect('/drug-lookup?msg=barcode_dup&q=' + encodeURIComponent(ref.name_en)); // الباركود مستخدم لصنف تاني
      throw err;
    }

    await logActivity(req, { action: 'إضافة صنف من دليل الأدوية', entityType: 'medicine', details: { medicine_name: ref.name_en } });
    res.redirect('/products?q=' + encodeURIComponent(ref.name_en));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
