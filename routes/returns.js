// routes/returns.js
// المرتجعات: كل خطوات المرتجع (التحقق من الكمية، المبلغ بعد الخصم، المخزون على التشغيلة الأصلية،
// حركة الخزنة، سجل التدقيق) بتتم جوه دالة واحدة في قاعدة البيانات: create_return() — transaction واحدة.
const crypto = require('crypto');
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { isBusinessError, statusFor, userMessage, cleanKey } = require('../lib/errors');

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

    // مفتاح منع تكرار تسجيل نفس المرتجع لو الفورم اتبعت مرتين
    res.render('returns', { returns, error: null, idemKey: 'ret-' + crypto.randomUUID(), active: 'returns' });
  } catch (err) {
    next(err);
  }
});

// بحث عن فاتورة برقمها لعرض بنودها القابلة للإرجاع
router.get('/invoice/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const invoice = Number.isInteger(id) ? await queryOne('SELECT * FROM sale_invoices WHERE id = $1', [id]) : null;
    if (!invoice) return res.json({ found: false });
    if (invoice.status === 'voided') return res.json({ found: false, message: 'الفاتورة دي ملغاة ومينفعش عليها مرتجع' });

    // الكمية المرتجعة سابقًا بنفس وحدة بيع البند (مربوطة ببند الفاتورة نفسه مش بالصنف)
    const items = await query(`
      SELECT si.*, COALESCE((
        SELECT SUM(r.quantity) FROM returns r WHERE r.sale_item_id = si.id
      ), 0)::int AS already_returned_qty
      FROM sale_items si WHERE si.invoice_id = $1 ORDER BY si.id
    `, [invoice.id]);

    res.json({ found: true, invoice, items });
  } catch (err) {
    next(err);
  }
});

// ============ تسجيل مرتجع جديد (أدمن / صيدلي) ============
router.post('/add', requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const { sale_item_id, quantity, reason, restock, refund_method } = req.body;

    const itemId = parseInt(sale_item_id, 10);
    if (!Number.isInteger(itemId)) return res.status(400).send('بند الفاتورة غير موجود');

    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).send('الكمية لازم تكون 1 أو أكتر');

    const method = refund_method ? String(refund_method) : null;
    if (method && !['cash', 'card', 'other', 'none'].includes(method)) return res.status(400).send('طريقة رد المبلغ غير صحيحة');

    // لو الصفحة قديمة ومفيهاش مفتاح: نولّد مفتاح من (المستخدم + البند + الكمية + شريحة 10 ثواني) كحماية من الضغط المزدوج
    const key = cleanKey(req.body.idempotency_key)
      || `auto-${req.session.userId}-${itemId}-${qty}-${Math.floor(Date.now() / 10000)}`;

    await query('SELECT create_return($1, $2, $3, $4, $5, $6, $7, $8) AS result', [
      itemId,
      qty,
      reason || null,
      restock === 'on',
      method,
      req.session.userId,
      req.session.username || null,
      key
    ]);

    res.redirect('/returns');
  } catch (err) {
    if (isBusinessError(err)) return res.status(statusFor(err)).send(userMessage(err));
    next(err);
  }
});

// إيصال طباعة لمرتجع واحد
router.get('/:id/receipt', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ret = Number.isInteger(id) ? await queryOne(`
      SELECT r.*, si.customer_name
      FROM returns r
      LEFT JOIN sale_invoices si ON si.id = r.invoice_id
      WHERE r.id = $1
    `, [id]) : null;
    if (!ret) return res.status(404).send('المرتجع غير موجود');
    res.render('returns-receipt', { ret });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
