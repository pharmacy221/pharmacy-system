// routes/products.js
// إدارة الأصناف (الأدوية/المستحضرات) + التشغيلات (batches) والصلاحية
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { FORMS, FORM_ORDER, saleLevels } = require('../lib/drug-form');

const router = express.Router();
router.use(requireLogin);

const PAGE_SIZE = 60;
// متغيرات مشتركة لكل صفحات الأصناف (الترقيم + الفلاتر + نوع المنتج + اسم الوحدة)
router.use((req, res, next) => {
  res.locals.pg = { page: 1, pages: 1, total: null, form: '', instock: false };
  res.locals.formKinds = Object.entries(FORMS).map(([key, f]) => ({ key, label: f.label }));
  res.locals.unitName = (p) => saleLevels(p).levels[0].label;
  // اسم القسم/النوع اللي بيظهر جنب الصنف (حبوب / فوار / حقن ...)
  res.locals.formLabel = (p) => (p.form_kind && FORMS[p.form_kind] ? FORMS[p.form_kind].label : 'غير مصنّف');
  res.locals.groups = [];
  next();
});

const CATEGORIES = ['أدوية', 'مستحضرات تجميل', 'مكملات غذائية', 'أدوات طبية', 'رضاعة وأطفال', 'أخرى'];

// ترتيب الأقسام: حبوب ← فوار ← كبسول ← حقن ... (الأصناف بدون نوع في الآخر)
const GROUP_ORDER_SQL = `COALESCE(array_position(ARRAY[${FORM_ORDER.map((k) => `'${k}'`).join(',')}]::text[], form_kind), 999)`;

function buildWhere({ q, form, instock }) {
  const params = [];
  const where = ['is_active = true'];
  if (q && q.trim()) {
    params.push(`%${q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    where.push(`(name ILIKE $1 OR generic_name ILIKE $1 OR barcode ILIKE $1 OR serial_number ILIKE $1 OR conditions_tags ILIKE $1)`);
  }
  if (form === 'none') where.push('form_kind IS NULL');
  else if (form && FORMS[form]) { params.push(form); where.push(`form_kind = $${params.length}`); }
  if (instock) where.push('stock_units > 0');
  return { w: where.join(' AND '), params };
}

// عدد الأصناف في كل قسم (بيحترم البحث و"المتاح فقط" بس مش فلتر القسم نفسه)
async function getGroupCounts({ q, instock }) {
  const { w, params } = buildWhere({ q, instock });
  const rows = await query(`SELECT form_kind, COUNT(*)::int AS c FROM medicines WHERE ${w} GROUP BY form_kind`, params);
  const byKind = new Map(rows.map((r) => [r.form_kind, r.c]));
  const groups = FORM_ORDER.filter((k) => byKind.get(k)).map((k) => ({ key: k, label: FORMS[k].label, count: byKind.get(k) }));
  if (byKind.get(null)) groups.push({ key: 'none', label: 'غير مصنّف', count: byKind.get(null) });
  return groups;
}

// بحث + فلتر القسم + المتاح فقط + ترقيم (الدليل فيه آلاف الأصناف)
async function getMedicinesPage({ q, form, instock, page }) {
  const { w, params } = buildWhere({ q, form, instock });
  const total = (await queryOne(`SELECT COUNT(*)::int AS c FROM medicines WHERE ${w}`, params)).c;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const p = Math.min(Math.max(parseInt(page) || 1, 1), pages);
  const rows = await query(
    `SELECT * FROM medicines WHERE ${w} ORDER BY ${GROUP_ORDER_SQL}, lower(name) LIMIT ${PAGE_SIZE} OFFSET ${(p - 1) * PAGE_SIZE}`,
    params
  );
  return { rows, total, pages, page: p };
}

// نسخة مختصرة للصفحات اللي بترجع بخطأ (أول صفحة بس)
async function getMedicines(q) {
  return (await getMedicinesPage({ q, page: 1 })).rows;
}

// يحوّل قيمة سن (نص) لرقم أو null لو فاضية
function parseAge(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(val);
  return Number.isNaN(n) ? null : n;
}

// ============ قائمة الأصناف ============
router.get('/', async (req, res, next) => {
  try {
    const form = req.query.form || '';
    const instock = req.query.instock === '1';
    const [r, groups] = await Promise.all([
      getMedicinesPage({ q: req.query.q, form, instock, page: req.query.page }),
      getGroupCounts({ q: req.query.q, instock })
    ]);
    res.locals.groups = groups;
    res.locals.pg = { page: r.page, pages: r.pages, total: r.total, form, instock };
    res.render('products', { medicines: r.rows, categories: CATEGORIES, error: null, searchQuery: req.query.q || '', active: 'products' });
  } catch (err) {
    next(err);
  }
});

// ============ إضافة صنف جديد ============
router.post('/add', async (req, res, next) => {
  try {
    const {
      name, generic_name, category, dosage_form, manufacturer, barcode, serial_number,
      requires_prescription, controlled_substance,
      units_per_strip, strips_per_box,
      sale_price_unit, sale_price_strip, sale_price_box,
      cost_price_unit, stock_units, min_stock_units,
      conditions_tags, min_age_years, max_age_years, form_kind
    } = req.body;
    const kind = FORMS[form_kind] ? form_kind : null;

    if (!name || !name.trim() || sale_price_unit === undefined || sale_price_unit === '') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'اسم الصنف وسعر بيع الحبة مطلوبين', searchQuery: '', active: 'products' });
    }

    await query(
      `INSERT INTO medicines (
          name, generic_name, category, dosage_form, manufacturer, barcode, serial_number,
          requires_prescription, controlled_substance,
          units_per_strip, strips_per_box,
          sale_price_unit, sale_price_strip, sale_price_box,
          cost_price_unit, stock_units, min_stock_units,
          conditions_tags, min_age_years, max_age_years, form_kind
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        name.trim(),
        generic_name && generic_name.trim() ? generic_name.trim() : null,
        (category || 'أدوية').trim(),
        dosage_form && dosage_form.trim() ? dosage_form.trim() : null,
        manufacturer && manufacturer.trim() ? manufacturer.trim() : null,
        barcode && barcode.trim() ? barcode.trim() : null,
        serial_number && serial_number.trim() ? serial_number.trim() : null,
        requires_prescription === 'on',
        controlled_substance === 'on',
        parseInt(units_per_strip) || 1,
        parseInt(strips_per_box) || 1,
        parseFloat(sale_price_unit) || 0,
        sale_price_strip ? parseFloat(sale_price_strip) : null,
        sale_price_box ? parseFloat(sale_price_box) : null,
        parseFloat(cost_price_unit) || 0,
        parseInt(stock_units) || 0,
        parseInt(min_stock_units) || 10,
        conditions_tags && conditions_tags.trim() ? conditions_tags.trim() : null,
        parseAge(min_age_years),
        parseAge(max_age_years),
        kind
      ]
    );

    await logActivity(req, { action: 'إضافة صنف جديد', entityType: 'medicine', details: { medicine_name: name.trim() } });
    res.redirect('/products');
  } catch (err) {
    if (err.code === '23505') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'الباركود أو السريال ده مستخدم في صنف تاني بالفعل', searchQuery: '', active: 'products' });
    }
    next(err);
  }
});

// ============ تعديل صنف ============
router.post('/:id/update', async (req, res, next) => {
  try {
    const {
      name, generic_name, category, dosage_form, manufacturer, barcode, serial_number,
      requires_prescription, controlled_substance,
      units_per_strip, strips_per_box,
      sale_price_unit, sale_price_strip, sale_price_box,
      cost_price_unit, min_stock_units,
      conditions_tags, min_age_years, max_age_years, form_kind
    } = req.body;
    const kind = FORMS[form_kind] ? form_kind : null;

    await query(
      `UPDATE medicines SET
          name = $1, generic_name = $2, category = $3, dosage_form = $4, manufacturer = $5, barcode = $6, serial_number = $7,
          requires_prescription = $8, controlled_substance = $9,
          units_per_strip = $10, strips_per_box = $11,
          sale_price_unit = $12, sale_price_strip = $13, sale_price_box = $14,
          cost_price_unit = $15, min_stock_units = $16,
          conditions_tags = $17, min_age_years = $18, max_age_years = $19, form_kind = COALESCE($20, form_kind)
       WHERE id = $21`,
      [
        name.trim(),
        generic_name && generic_name.trim() ? generic_name.trim() : null,
        (category || 'أدوية').trim(),
        dosage_form && dosage_form.trim() ? dosage_form.trim() : null,
        manufacturer && manufacturer.trim() ? manufacturer.trim() : null,
        barcode && barcode.trim() ? barcode.trim() : null,
        serial_number && serial_number.trim() ? serial_number.trim() : null,
        requires_prescription === 'on',
        controlled_substance === 'on',
        parseInt(units_per_strip) || 1,
        parseInt(strips_per_box) || 1,
        parseFloat(sale_price_unit) || 0,
        sale_price_strip ? parseFloat(sale_price_strip) : null,
        sale_price_box ? parseFloat(sale_price_box) : null,
        parseFloat(cost_price_unit) || 0,
        parseInt(min_stock_units) || 10,
        conditions_tags && conditions_tags.trim() ? conditions_tags.trim() : null,
        parseAge(min_age_years),
        parseAge(max_age_years),
        kind,
        req.params.id
      ]
    );

    await logActivity(req, { action: 'تعديل بيانات صنف', entityType: 'medicine', entityId: req.params.id });
    res.redirect('/products');
  } catch (err) {
    if (err.code === '23505') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'الباركود أو السريال ده مستخدم في صنف تاني بالفعل', searchQuery: '', active: 'products' });
    }
    next(err);
  }
});

// ============ إلغاء تفعيل صنف (بدل الحذف النهائي عشان تاريخ المبيعات القديم يفضل سليم) ============
router.post('/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await query('UPDATE medicines SET is_active = false WHERE id = $1', [req.params.id]);
    await logActivity(req, { action: 'إلغاء تفعيل صنف', entityType: 'medicine', entityId: req.params.id });
    res.redirect('/products');
  } catch (err) {
    next(err);
  }
});

// ============ التشغيلات (Batches) + تنبيهات الصلاحية ============
router.get('/batches', async (req, res, next) => {
  try {
    const medicines = await query('SELECT id, name, units_per_strip, strips_per_box FROM medicines WHERE is_active = true ORDER BY lower(name)');
    const suppliers = await query('SELECT id, name FROM suppliers ORDER BY lower(name)');

    const batches = await query(`
      SELECT b.*, m.name AS medicine_name, s.name AS supplier_name,
             (b.expiry_date - CURRENT_DATE) AS days_left
      FROM batches b
      JOIN medicines m ON m.id = b.medicine_id
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.quantity_units > 0
      ORDER BY b.expiry_date ASC
    `);

    res.render('batches', { medicines, suppliers, batches, active: 'batches', error: null });
  } catch (err) {
    next(err);
  }
});

// إضافة تشغيلة جديدة (استلام بضاعة) - المخزون والتكلفة بيتحدّثوا أوتوماتيك بالـ trigger
router.post('/batches/add', async (req, res, next) => {
  try {
    const { medicine_id, supplier_id, batch_number, expiry_date, received_units, cost_price_unit } = req.body;

    if (!medicine_id || !expiry_date || !received_units || !cost_price_unit) {
      return res.status(400).send('كل الحقول (الصنف، تاريخ الصلاحية، الكمية، سعر التكلفة) مطلوبة');
    }

    await query(
      `INSERT INTO batches (medicine_id, supplier_id, batch_number, expiry_date, received_units, quantity_units, cost_price_unit)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [
        medicine_id,
        supplier_id || null,
        batch_number && batch_number.trim() ? batch_number.trim() : null,
        expiry_date,
        parseInt(received_units),
        parseFloat(cost_price_unit)
      ]
    );

    await logActivity(req, {
      action: 'استلام تشغيلة جديدة',
      entityType: 'batch',
      details: { medicine_id, quantity: parseInt(received_units), expiry_date }
    });
    res.redirect('/products/batches');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
