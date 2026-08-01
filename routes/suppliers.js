// routes/suppliers.js
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    let suppliers;
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      suppliers = await query(`SELECT * FROM suppliers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY id DESC`, [term]);
    } else {
      suppliers = await query('SELECT * FROM suppliers ORDER BY id DESC');
    }
    res.render('suppliers', { suppliers: suppliers || [], searchQuery: q || '', active: 'suppliers' });
  } catch (err) {
    next(err);
  }
});

router.post('/add', async (req, res, next) => {
  const { name, phone, address, notes } = req.body;
  try {
    if (!name || !name.trim()) return res.status(400).send('اسم المورد مطلوب');
    await query(
      `INSERT INTO suppliers (name, phone, address, notes) VALUES ($1, $2, $3, $4)`,
      [name.trim(), phone || null, address || null, notes || null]
    );
    await logActivity(req, { action: 'إضافة مورد', entityType: 'supplier', details: { supplier_name: name.trim() } });
    res.redirect('/suppliers');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/update', async (req, res, next) => {
  const { name, phone, address, notes } = req.body;
  try {
    if (!name || !name.trim()) return res.status(400).send('اسم المورد مطلوب');
    await query(
      `UPDATE suppliers SET name = $1, phone = $2, address = $3, notes = $4 WHERE id = $5`,
      [name.trim(), phone || null, address || null, notes || null, req.params.id]
    );
    res.redirect('/suppliers/' + req.params.id);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
    await logActivity(req, { action: 'حذف مورد', entityType: 'supplier', entityId: req.params.id });
    res.redirect('/suppliers');
  } catch (err) {
    next(err);
  }
});

// تفاصيل المورد + التشغيلات اللي وصلت منه
router.get('/:id', async (req, res, next) => {
  try {
    const supplier = await queryOne('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    if (!supplier) return res.status(404).send('المورد غير موجود');

    const batches = await query(`
      SELECT b.*, m.name AS medicine_name
      FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.supplier_id = $1
      ORDER BY b.received_at DESC
    `, [req.params.id]);

    const totalPurchased = batches.reduce((sum, b) => sum + Number(b.received_units) * Number(b.cost_price_unit), 0);

    res.render('supplier-detail', { supplier, batches, totalPurchased, active: 'suppliers' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
