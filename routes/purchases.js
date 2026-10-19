// routes/purchases.js — فواتير الشراء من الموردين + دفعات الموردين
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { BusinessError, isBusinessError, statusFor, userMessage, cleanKey } = require('../lib/errors');

router.use(requireLogin, requireRole('admin', 'pharmacist'));
const adminOnly = requireRole('admin');

function parseDateStrict(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// الأرقام من الفورم: بنقبل بس أرقام عادية (مفيش NaN/Infinity)
function parseMoney(v, field, { allowZero = true } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new BusinessError(`${field} غير صحيح`);
  return n;
}

// ============ قائمة فواتير الشراء ============
router.get('/', async (req, res, next) => {
  try {
    const supplierId = parseId(req.query.supplier);
    const status = ['received', 'cancelled'].includes(req.query.status) ? req.query.status : '';
    const unpaid = req.query.unpaid === '1';
    const q = (req.query.q || '').trim();

    const where = []; const params = [];
    if (supplierId) { params.push(supplierId); where.push(`pi.supplier_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`pi.status = $${params.length}`); }
    if (unpaid) where.push(`pi.status = 'received' AND pi.paid_amount < pi.total_amount`);
    if (q) { params.push(`%${q}%`); where.push(`(pi.invoice_number ILIKE $${params.length} OR s.name ILIKE $${params.length})`); }

    const [invoices, suppliers, totals] = await Promise.all([
      query(`
        SELECT pi.*, s.name AS supplier_name,
               (pi.total_amount - pi.paid_amount) AS remaining,
               (pi.status = 'received' AND pi.due_date IS NOT NULL AND pi.due_date < pharmacy_today() AND pi.paid_amount < pi.total_amount) AS overdue
        FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY pi.invoice_date DESC, pi.id DESC LIMIT 300`, params),
      query('SELECT id, name FROM suppliers ORDER BY name'),
      queryOne(`SELECT COALESCE(SUM(balance_due),0) AS due, COALESCE(SUM(overdue_due),0) AS overdue FROM v_supplier_balances`)
    ]);
    res.render('purchases', {
      invoices, suppliers, totals,
      filters: { supplier: supplierId || '', status, unpaid, q },
      isAdmin: req.session.role === 'admin', active: 'purchases'
    });
  } catch (err) { next(err); }
});

async function renderNew(res, req, extra = {}) {
  const [suppliers, medicines, today] = await Promise.all([
    query('SELECT id, name FROM suppliers ORDER BY name'),
    query(`SELECT id, name, barcode, units_per_strip AS ups, strips_per_box AS spb FROM medicines WHERE is_active = true ORDER BY name`),
    queryOne(`SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS today`)
  ]);
  const status = extra.error ? (extra.status || 400) : 200;
  res.status(status).render('purchase-new', {
    suppliers, medicines, today: today.today, error: null, form: {},
    idempotencyKey: `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    active: 'purchases', ...extra
  });
}

router.get('/new', async (req, res, next) => {
  try { await renderNew(res, req, { form: { supplier_id: req.query.supplier || '' } }); } catch (err) { next(err); }
});

// الأصناف كـ JSON ('items_json') من الصفحة؛ كل التحقق الحقيقي في دالة قاعدة البيانات
router.post('/create', async (req, res, next) => {
  const b = req.body || {};
  try {
    const supplierId = parseId(b.supplier_id);
    if (!supplierId) throw new BusinessError('اختار المورد');
    let items;
    try { items = JSON.parse(b.items_json || '[]'); } catch (e) { throw new BusinessError('بنود الفاتورة غير صحيحة'); }
    if (!Array.isArray(items) || items.length === 0) throw new BusinessError('لازم تضيف صنف واحد على الأقل');
    items = items.map((i) => ({
      medicine_id: parseId(i.medicine_id), unit: String(i.unit || 'unit'), quantity: Number(i.quantity),
      cost: Number(i.cost), expiry_date: parseDateStrict(String(i.expiry_date || '')), batch_number: i.batch_number ? String(i.batch_number).slice(0, 80) : null
    }));
    items.forEach((i, idx) => {
      if (!i.medicine_id) throw new BusinessError(`البند رقم ${idx + 1}: اختار الصنف من القائمة`);
      if (!Number.isInteger(i.quantity) || i.quantity <= 0) throw new BusinessError(`البند رقم ${idx + 1}: الكمية لازم تكون رقم صحيح أكبر من صفر`);
      if (!Number.isFinite(i.cost) || i.cost < 0) throw new BusinessError(`البند رقم ${idx + 1}: السعر غير صحيح`);
      if (!i.expiry_date) throw new BusinessError(`البند رقم ${idx + 1}: تاريخ الصلاحية مطلوب`);
    });
    const invoiceDate = b.invoice_date ? parseDateStrict(b.invoice_date) : null;
    const dueDate = b.due_date ? parseDateStrict(b.due_date) : null;
    if (b.invoice_date && !invoiceDate) throw new BusinessError('تاريخ الفاتورة غير صحيح');
    if (b.due_date && !dueDate) throw new BusinessError('تاريخ الاستحقاق غير صحيح');
    const paid = parseMoney(b.paid_amount, 'المبلغ المدفوع');
    const method = ['cash', 'bank', 'other'].includes(b.method) ? b.method : 'cash';

    const row = await queryOne(
      `SELECT create_purchase_invoice($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) AS id`,
      [supplierId, (b.invoice_number || '').slice(0, 80), invoiceDate, dueDate, (b.notes || '').slice(0, 500),
       req.session.userId, req.session.username, JSON.stringify(items), paid, method, cleanKey(b.idempotency_key)]
    );
    res.redirect('/purchases/' + row.id);
  } catch (err) {
    if (isBusinessError(err)) {
      if (err.code === 'PH003' && cleanKey(b.idempotency_key)) {
        // الفاتورة اتسجلت قبل كده بنفس المفتاح (دبل كليك): نوديه عليها بدل رسالة خطأ
        const ex = await queryOne('SELECT id FROM purchase_invoices WHERE idempotency_key = $1', [cleanKey(b.idempotency_key)]).catch(() => null);
        if (ex) return res.redirect('/purchases/' + ex.id);
      }
      try {
        return await renderNew(res, req, { error: userMessage(err), status: statusFor(err), form: b });
      } catch (e2) { return next(e2); }
    }
    next(err);
  }
});

// ============ تفاصيل الفاتورة ============
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).render('error', { code: 404, message: 'الفاتورة غير موجودة' });
    const invoice = await queryOne(`
      SELECT pi.*, s.name AS supplier_name, u.full_name AS created_by_name, (pi.total_amount - pi.paid_amount) AS remaining
      FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id LEFT JOIN users u ON u.id = pi.created_by
      WHERE pi.id = $1`, [id]);
    if (!invoice) return res.status(404).render('error', { code: 404, message: 'الفاتورة غير موجودة' });
    const [items, payments] = await Promise.all([
      query(`SELECT i.*, m.name AS medicine_name, b.quantity_units AS batch_remaining
             FROM purchase_invoice_items i JOIN medicines m ON m.id = i.medicine_id LEFT JOIN batches b ON b.id = i.batch_id
             WHERE i.invoice_id = $1 ORDER BY i.id`, [id]),
      query(`SELECT p.*, u.full_name AS user_name FROM supplier_payments p LEFT JOIN users u ON u.id = p.created_by
             WHERE p.invoice_id = $1 ORDER BY p.id`, [id])
    ]);
    res.render('purchase-detail', {
      invoice, items, payments, isAdmin: req.session.role === 'admin',
      error: req.query.error || null, ok: req.query.ok || null, active: 'purchases'
    });
  } catch (err) { next(err); }
});

function back(res, id, key, msg) { return res.redirect(`/purchases/${id}?${key}=${encodeURIComponent(msg)}`); }

router.post('/:id/pay', adminOnly, async (req, res, next) => {
  const id = parseId(req.params.id);
  try {
    if (!id) throw new BusinessError('الفاتورة غير صحيحة', 404);
    const inv = await queryOne('SELECT supplier_id FROM purchase_invoices WHERE id = $1', [id]);
    if (!inv) throw new BusinessError('الفاتورة غير موجودة', 404);
    const amount = parseMoney(req.body.amount, 'المبلغ', { allowZero: false });
    if (amount <= 0) throw new BusinessError('المبلغ لازم يكون أكبر من صفر');
    const method = ['cash', 'bank', 'other'].includes(req.body.method) ? req.body.method : 'cash';
    await query('SELECT record_supplier_payment($1,$2,$3,$4,$5,$6,$7)',
      [inv.supplier_id, id, amount, method, (req.body.note || '').slice(0, 300), req.session.userId, req.session.username]);
    back(res, id, 'ok', 'تم تسجيل الدفعة');
  } catch (err) {
    if (isBusinessError(err) && id) return back(res, id, 'error', userMessage(err));
    next(err);
  }
});

router.post('/:id/cancel', adminOnly, async (req, res, next) => {
  const id = parseId(req.params.id);
  try {
    if (!id) throw new BusinessError('الفاتورة غير صحيحة', 404);
    await query('SELECT cancel_purchase_invoice($1,$2,$3,$4)', [id, req.session.userId, req.session.username, (req.body.reason || '').slice(0, 300)]);
    back(res, id, 'ok', 'تم إلغاء الفاتورة وعكس المخزون');
  } catch (err) {
    if (isBusinessError(err) && id) return back(res, id, 'error', userMessage(err));
    next(err);
  }
});

module.exports = router;
