// routes/returns.js
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res, next) => {
  try {
    const returns = await query(`
      SELECT r.*, si.customer_name, si.created_at AS invoice_date
      FROM returns r
      LEFT JOIN sale_invoices si ON si.id = r.invoice_id
      ORDER BY r.created_at DESC
      LIMIT 200
    `);

    res.render('returns', { returns, error: null, active: 'returns' });
  } catch (err) {
    next(err);
  }
});

// بحث عن فاتورة برقمها لعرض بنودها القابلة للإرجاع
router.get('/invoice/:id', async (req, res, next) => {
  try {
    const invoice = await queryOne('SELECT * FROM sale_invoices WHERE id = $1', [req.params.id]);
    if (!invoice) return res.json({ found: false });

    const items = await query(`
      SELECT si.*, COALESCE((
        SELECT SUM(r.quantity_units) FROM returns r WHERE r.invoice_id = si.invoice_id AND r.medicine_id = si.medicine_id
      ), 0) AS already_returned_units
      FROM sale_items si WHERE si.invoice_id = $1 ORDER BY si.id
    `, [invoice.id]);

    res.json({ found: true, invoice, items });
  } catch (err) {
    next(err);
  }
});

// ============ تسجيل مرتجع جديد ============
router.post('/add', async (req, res, next) => {
  try {
    const { invoice_id, sale_item_id, quantity, reason, restock } = req.body;

    const saleItem = await queryOne('SELECT * FROM sale_items WHERE id = $1', [sale_item_id]);
    if (!saleItem) return res.status(400).send('بند الفاتورة غير موجود');

    const qty = parseInt(quantity) || 1;
    const unitsPerQty = saleItem.quantity_units / saleItem.quantity; // للتحويل لنفس وحدة sale_unit
    const quantityUnits = Math.round(qty * unitsPerQty);
    const refundAmount = Math.round((Number(saleItem.unit_price) * qty) * 100) / 100;

    await query(
      `INSERT INTO returns (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, refund_amount, reason, restocked, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        invoice_id || saleItem.invoice_id,
        saleItem.medicine_id,
        saleItem.medicine_name_snapshot,
        saleItem.sale_unit,
        qty,
        quantityUnits,
        refundAmount,
        reason || null,
        restock === 'on',
        req.session.userId
      ]
    );

    await logActivity(req, {
      action: 'تسجيل مرتجع',
      entityType: 'return',
      details: { medicine_name: saleItem.medicine_name_snapshot, quantity: qty, reason: reason || null }
    });
    res.redirect('/returns');
  } catch (err) {
    next(err);
  }
});

// إيصال طباعة لمرتجع واحد
router.get('/:id/receipt', async (req, res, next) => {
  try {
    const ret = await queryOne(`
      SELECT r.*, si.customer_name
      FROM returns r
      LEFT JOIN sale_invoices si ON si.id = r.invoice_id
      WHERE r.id = $1
    `, [req.params.id]);
    if (!ret) return res.status(404).send('المرتجع غير موجود');
    res.render('returns-receipt', { ret });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
