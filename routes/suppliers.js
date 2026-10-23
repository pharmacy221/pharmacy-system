// routes/suppliers.js
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { isBusinessError, userMessage } = require('../lib/errors');
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    let suppliers;
    const cols = `s.*, COALESCE(b.balance_due, 0) AS balance_due, COALESCE(b.overdue_due, 0) AS overdue_due`;
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      suppliers = await query(`SELECT ${cols} FROM suppliers s LEFT JOIN v_supplier_balances b ON b.supplier_id = s.id WHERE s.name ILIKE $1 OR s.phone ILIKE $1 OR s.company ILIKE $1 OR s.rep_name ILIKE $1 ORDER BY s.id DESC`, [term]);
    } else {
      suppliers = await query(`SELECT ${cols} FROM suppliers s LEFT JOIN v_supplier_balances b ON b.supplier_id = s.id ORDER BY s.id DESC`);
    }
    res.render('suppliers', { suppliers: suppliers || [], searchQuery: q || '', active: 'suppliers' });
  } catch (err) {
    next(err);
  }
});

router.post('/add', async (req, res, next) => {
  const { name, phone, address, notes, company, rep_name } = req.body;
  try {
    if (!name || !name.trim()) return res.status(400).send('اسم المورد مطلوب');
    await query(
      `INSERT INTO suppliers (name, phone, address, notes, company, rep_name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [name.trim(), phone || null, address || null, notes || null, (company || '').trim() || null, (rep_name || '').trim() || null]
    );
    await logActivity(req, { action: 'إضافة مورد', entityType: 'supplier', details: { supplier_name: name.trim() } });
    res.redirect('/suppliers');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/update', async (req, res, next) => {
  const { name, phone, address, notes, company, rep_name } = req.body;
  try {
    if (!name || !name.trim()) return res.status(400).send('اسم المورد مطلوب');
    await query(
      `UPDATE suppliers SET name = $1, phone = $2, address = $3, notes = $4, company = $5, rep_name = $6 WHERE id = $7`,
      [name.trim(), phone || null, address || null, notes || null, (company || '').trim() || null, (rep_name || '').trim() || null, req.params.id]
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
    if (err && (err.code === '23503' || err.code === '23001')) return res.status(409).send('مينفعش تحذف مورد عليه فواتير شراء أو دفعات (محفوظة للحسابات)');
    next(err);
  }
});

// دفعة على حساب المورد (بتتوزع على أقدم فواتير مستحقة)
router.post('/:id/pay', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  try {
    const amount = Number(req.body.amount);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).send('المورد غير موجود');
    if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('المبلغ لازم يكون أكبر من صفر'), { code: 'PH001' });
    const method = ['cash', 'bank', 'other'].includes(req.body.method) ? req.body.method : 'cash';
    await query('SELECT record_supplier_payment($1, NULL, $2, $3, $4, $5, $6)',
      [id, amount, method, (req.body.note || '').slice(0, 300), req.session.userId, req.session.username]);
    res.redirect(`/suppliers/${id}?ok=${encodeURIComponent('تم تسجيل الدفعة')}`);
  } catch (err) {
    if (isBusinessError(err)) return res.redirect(`/suppliers/${id}?error=${encodeURIComponent(userMessage(err))}`);
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

    const [balance, invoices, payments] = await Promise.all([
      queryOne('SELECT * FROM v_supplier_balances WHERE supplier_id = $1', [req.params.id]),
      query(`SELECT *, (total_amount - paid_amount) AS remaining,
                    (status = 'received' AND due_date IS NOT NULL AND due_date < pharmacy_today() AND paid_amount < total_amount) AS overdue
             FROM purchase_invoices WHERE supplier_id = $1 ORDER BY invoice_date DESC, id DESC LIMIT 100`, [req.params.id]),
      query(`SELECT p.*, pi.invoice_number FROM supplier_payments p JOIN purchase_invoices pi ON pi.id = p.invoice_id
             WHERE p.supplier_id = $1 ORDER BY p.id DESC LIMIT 100`, [req.params.id])
    ]);

    res.render('supplier-detail', {
      supplier, batches, totalPurchased, balance, invoices, payments,
      error: req.query.error || null, ok: req.query.ok || null, active: 'suppliers'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
