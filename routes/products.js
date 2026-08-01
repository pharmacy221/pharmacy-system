// routes/products.js
// إدارة الأصناف (الأدوية/المستحضرات) + التشغيلات (batches) والصلاحية
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

const router = express.Router();
router.use(requireLogin);

const CATEGORIES = ['أدوية', 'مستحضرات تجميل', 'مكملات غذائية', 'أدوات طبية', 'رضاعة وأطفال', 'أخرى'];

async function getMedicines(q) {
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    return query(
      `SELECT * FROM medicines WHERE is_active = true AND (name ILIKE $1 OR generic_name ILIKE $1 OR barcode ILIKE $1)
       ORDER BY lower(name)`,
      [term]
    );
  }
  return query('SELECT * FROM medicines WHERE is_active = true ORDER BY lower(name)');
}

// ============ قائمة الأصناف ============
router.get('/', async (req, res, next) => {
  try {
    const medicines = await getMedicines(req.query.q);
    res.render('products', { medicines, categories: CATEGORIES, error: null, searchQuery: req.query.q || '', active: 'products' });
  } catch (err) {
    next(err);
  }
});

// ============ إضافة صنف جديد ============
router.post('/add', async (req, res, next) => {
  try {
    const {
      name, generic_name, category, dosage_form, manufacturer, barcode,
      requires_prescription, controlled_substance,
      units_per_strip, strips_per_box,
      sale_price_unit, sale_price_strip, sale_price_box,
      cost_price_unit, stock_units, min_stock_units
    } = req.body;

    if (!name || !name.trim() || sale_price_unit === undefined || sale_price_unit === '') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'اسم الصنف وسعر بيع الحبة مطلوبين', searchQuery: '', active: 'products' });
    }

    await query(
      `INSERT INTO medicines (
          name, generic_name, category, dosage_form, manufacturer, barcode,
          requires_prescription, controlled_substance,
          units_per_strip, strips_per_box,
          sale_price_unit, sale_price_strip, sale_price_box,
          cost_price_unit, stock_units, min_stock_units
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        name.trim(),
        generic_name && generic_name.trim() ? generic_name.trim() : null,
        (category || 'أدوية').trim(),
        dosage_form && dosage_form.trim() ? dosage_form.trim() : null,
        manufacturer && manufacturer.trim() ? manufacturer.trim() : null,
        barcode && barcode.trim() ? barcode.trim() : null,
        requires_prescription === 'on',
        controlled_substance === 'on',
        parseInt(units_per_strip) || 1,
        parseInt(strips_per_box) || 1,
        parseFloat(sale_price_unit) || 0,
        sale_price_strip ? parseFloat(sale_price_strip) : null,
        sale_price_box ? parseFloat(sale_price_box) : null,
        parseFloat(cost_price_unit) || 0,
        parseInt(stock_units) || 0,
        parseInt(min_stock_units) || 10
      ]
    );

    await logActivity(req, { action: 'إضافة صنف جديد', entityType: 'medicine', details: { medicine_name: name.trim() } });
    res.redirect('/products');
  } catch (err) {
    if (err.code === '23505') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'الباركود ده مستخدم في صنف تاني بالفعل', searchQuery: '', active: 'products' });
    }
    next(err);
  }
});

// ============ تعديل صنف ============
router.post('/:id/update', async (req, res, next) => {
  try {
    const {
      name, generic_name, category, dosage_form, manufacturer, barcode,
      requires_prescription, controlled_substance,
      units_per_strip, strips_per_box,
      sale_price_unit, sale_price_strip, sale_price_box,
      cost_price_unit, min_stock_units
    } = req.body;

    await query(
      `UPDATE medicines SET
          name = $1, generic_name = $2, category = $3, dosage_form = $4, manufacturer = $5, barcode = $6,
          requires_prescription = $7, controlled_substance = $8,
          units_per_strip = $9, strips_per_box = $10,
          sale_price_unit = $11, sale_price_strip = $12, sale_price_box = $13,
          cost_price_unit = $14, min_stock_units = $15
       WHERE id = $16`,
      [
        name.trim(),
        generic_name && generic_name.trim() ? generic_name.trim() : null,
        (category || 'أدوية').trim(),
        dosage_form && dosage_form.trim() ? dosage_form.trim() : null,
        manufacturer && manufacturer.trim() ? manufacturer.trim() : null,
        barcode && barcode.trim() ? barcode.trim() : null,
        requires_prescription === 'on',
        controlled_substance === 'on',
        parseInt(units_per_strip) || 1,
        parseInt(strips_per_box) || 1,
        parseFloat(sale_price_unit) || 0,
        sale_price_strip ? parseFloat(sale_price_strip) : null,
        sale_price_box ? parseFloat(sale_price_box) : null,
        parseFloat(cost_price_unit) || 0,
        parseInt(min_stock_units) || 10,
        req.params.id
      ]
    );

    await logActivity(req, { action: 'تعديل بيانات صنف', entityType: 'medicine', entityId: req.params.id });
    res.redirect('/products');
  } catch (err) {
    if (err.code === '23505') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'الباركود ده مستخدم في صنف تاني بالفعل', searchQuery: '', active: 'products' });
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
