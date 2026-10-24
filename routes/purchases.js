// routes/purchases.js — فواتير الشراء من الموردين + دفعات الموردين
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { BusinessError, isBusinessError, statusFor, userMessage, cleanKey } = require('../lib/errors');
const { saleLevels, FORMS, FORM_ORDER } = require('../lib/drug-form');
const { logActivity } = require('../lib/activity-log');
const { cleanShortcut } = require('../lib/medicine-extras');

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


// ============ بحث الأصناف والموردين (لصفحة التشغيلات/الطلبيات) ============
// توحيد الحروف العربية عشان البحث ميتأثرش بالهمزات والتاء المربوطة
const normText = (t) => String(t || '').toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\u064B-\u0652\u0640]/g, '');
const SQL_NORM = (expr) => `translate(lower(${expr}), 'أإآةى', 'اااهي')`;
const escLike = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

// شكل الصنف المرجَّع للصفحة: الوحدات المتاحة + الوحدة الكبيرة كافتراضي
function shapeMed(m) {
  const lv = saleLevels(m);
  const big = lv.levels[lv.levels.length - 1];   // أكبر وحدة: علبة للحبوب/الفوار، أو وحدة الصنف (حقنة/شراب...)
  return {
    id: m.id, name: m.name, manufacturer: m.manufacturer, barcode: m.barcode, serial_number: m.serial_number,
    form: lv.formLabel, ups: m.units_per_strip, spb: m.strips_per_box, stock_units: m.stock_units,
    levels: lv.levels.map((l) => ({ key: l.key, label: l.label, qty: l.qty })), default_unit: big.key, default_label: big.label
  };
}

// آخر سعر شراء مسجّل لكل صنف (من آخر فاتورة شراء مستلمة)، بسعر الحبة قبل الخصم؛ وعلى أساسه الصفحة بتحسب سعر أي وحدة.
// لو الصنف مفيش له فواتير شراء (رصيد افتتاحي/مستورد) بنرجع متوسط تكلفة الحبة المسجّل عليه (source = 'avg').
async function attachLastCosts(rows, shaped) {
  if (!rows.length) return shaped;
  const ids = rows.map((r) => r.id);
  const last = await query(
    `SELECT DISTINCT ON (i.medicine_id) i.medicine_id,
            (i.entry_cost * i.entry_quantity / NULLIF(i.quantity_units, 0))::float8 AS unit_cost,
            i.discount_percent::float8 AS discount_percent, pi.invoice_date, s.name AS supplier_name
     FROM purchase_invoice_items i
     JOIN purchase_invoices pi ON pi.id = i.invoice_id AND pi.status = 'received'
     LEFT JOIN suppliers s ON s.id = pi.supplier_id
     WHERE i.medicine_id = ANY($1::int[])
     ORDER BY i.medicine_id, pi.invoice_date DESC, i.id DESC`, [ids]);
  const byId = new Map(last.map((r) => [r.medicine_id, r]));
  // السعر الرسمي (الموحّد) للعلبة من دليل الأدوية، لو الصنف مربوط بيه
  let official = new Map();
  try {
    const refs = await query(
      `SELECT m.id, d.price_egp FROM medicines m JOIN drug_reference d ON d.id = m.ref_id
       WHERE m.id = ANY($1::int[]) AND d.price_egp > 0`, [ids]);
    official = new Map(refs.map((r) => [r.id, Number(r.price_egp)]));
  } catch (e) { /* دليل الأدوية مش متركّب */ }
  // الأولوية: آخر فاتورة شراء ← السعر الرسمي ← سعر البيع المسجّل في الأصناف ← متوسط التكلفة
  return shaped.map((m, idx) => {
    const l = byId.get(m.id), r = rows[idx];
    const total = Math.max((parseInt(r.units_per_strip, 10) || 1) * (parseInt(r.strips_per_box, 10) || 1), 1);
    if (l && l.unit_cost != null) {
      const d = l.invoice_date instanceof Date ? l.invoice_date.toISOString().slice(0, 10) : String(l.invoice_date).slice(0, 10);
      return { ...m, last_cost: { unit_cost: l.unit_cost, discount_percent: l.discount_percent || 0, date: d, supplier: l.supplier_name || null, source: 'invoice' } };
    }
    const mk = (unit_cost, source) => ({ ...m, last_cost: { unit_cost, discount_percent: 0, date: null, supplier: null, source } });
    if (official.get(m.id)) return mk(official.get(m.id) / total, 'official');
    const box = Number(r.sale_price_box), unit = Number(r.sale_price_unit);
    if (box > 0) return mk(box / total, 'sale');
    if (unit > 0) return mk(unit, 'sale');
    const avg = Number(r.cost_price_unit);
    return avg > 0 ? mk(avg, 'avg') : { ...m, last_cost: null };
  });
}

// الأصناف: بالاسم / المادة الفعالة / الشركة المصنّعة / الباركود / السيريال (كل كلمة في أي مكان وبأي ترتيب)
router.get('/api/medicines', async (req, res, next) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (!raw) return res.json({ results: [] });
    const tokens = normText(raw).split(/\s+/).filter(Boolean).slice(0, 8);
    const hay = SQL_NORM(`concat_ws(' ', name, generic_name, manufacturer, barcode, serial_number)`);
    const params = [raw];
    const where = tokens.map((t) => { params.push(`%${escLike(t)}%`); return `${hay} LIKE $${params.length}`; });
    params.push(`${escLike(normText(raw))}%`);
    const iPrefix = params.length;
    const rows = await query(
      `SELECT id, name, generic_name, manufacturer, barcode, serial_number, form_kind, dosage_form,
              units_per_strip, strips_per_box, stock_units, cost_price_unit, sale_price_unit, sale_price_box
       FROM medicines
       WHERE is_active = true AND (barcode = $1 OR serial_number = $1 OR (${where.join(' AND ')}))
       ORDER BY (barcode = $1 OR serial_number = $1) DESC, (${SQL_NORM('name')} LIKE $${iPrefix}) DESC, lower(name)
       LIMIT 30`, params);
    res.json({
      exact: rows.length > 0 && (rows[0].barcode === raw || rows[0].serial_number === raw),
      results: await attachLastCosts(rows, rows.map(shapeMed))
    });
  } catch (err) { next(err); }
});

// الموردين: بالاسم أو الشركة اللي المندوب بيمثّلها أو اسم المندوب أو التليفون
router.get('/api/suppliers', async (req, res, next) => {
  try {
    const raw = String(req.query.q || '').trim();
    const tokens = normText(raw).split(/\s+/).filter(Boolean).slice(0, 6);
    const hay = SQL_NORM(`concat_ws(' ', name, company, rep_name, phone)`);
    const params = [];
    const where = tokens.map((t) => { params.push(`%${escLike(t)}%`); return `${hay} LIKE $${params.length}`; });
    const rows = await query(
      `SELECT id, name, company, rep_name, phone FROM suppliers ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY lower(name) LIMIT 30`, params);
    res.json({ results: rows });
  } catch (err) { next(err); }
});

// ---- إضافة مورد جديد بسرعة من صفحة التشغيلات (من غير مغادرة الصفحة) ----
router.post('/api/suppliers/add', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 150);
    if (!name) return res.status(400).json({ error: 'اسم المورد مطلوب' });
    const row = await queryOne(
      `INSERT INTO suppliers (name, phone, company, rep_name) VALUES ($1,$2,$3,$4) RETURNING id, name, company, rep_name, phone`,
      [name, String(b.phone || '').trim().slice(0, 40) || null, String(b.company || '').trim().slice(0, 150) || null, String(b.rep_name || '').trim().slice(0, 150) || null]);
    await logActivity(req, { action: 'إضافة مورد', entityType: 'supplier', entityId: row.id, details: { supplier_name: name, from: 'batches' } });
    res.json({ supplier: row });
  } catch (err) { next(err); }
});

// ---- إضافة صنف جديد بسرعة (اسم + باركود + نوع + تعبئة + سعر بيع العلبة) ----
router.post('/api/medicines/add', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'اسم الصنف مطلوب' });
    const kind = FORMS[b.form_kind] ? b.form_kind : 'tablet';
    const f = FORMS[kind];
    let ups = Math.min(Math.max(parseInt(b.units_per_strip, 10) || 1, 1), 100000);
    let spb = Math.min(Math.max(parseInt(b.strips_per_box, 10) || 1, 1), 100000);
    if (!f.counted) { ups = 1; spb = 1; } else if (!f.strip) { spb = 1; }
    const total = ups * spb;
    const boxPrice = b.sale_price_box === undefined || String(b.sale_price_box).trim() === '' ? 0 : Number(b.sale_price_box);
    if (!Number.isFinite(boxPrice) || boxPrice < 0 || boxPrice > 100000000) return res.status(400).json({ error: 'سعر البيع غير صحيح' });
    // سعر العلبة هو المدخل؛ سعر الشريط والحبة بيتحسبوا تلقائيًا
    const unitPrice = Math.round((boxPrice / total) * 100) / 100;
    const stripPrice = ups > 1 && spb > 1 ? Math.round((boxPrice / spb) * 100) / 100 : null;
    const boxCol = total > 1 ? boxPrice : null;
    const barcode = String(b.barcode || '').trim().slice(0, 64) || null;
    const serial = String(b.serial_number || '').trim().slice(0, 64) || null;
    const manufacturer = String(b.manufacturer || '').trim().slice(0, 150) || null;
    let shortcut;
    try { shortcut = cleanShortcut(b.shortcut_code); } catch (e) { return res.status(400).json({ error: e.message }); }

    let row;
    try {
      row = await queryOne(
        `INSERT INTO medicines (name, dosage_form, form_kind, manufacturer, barcode, serial_number, units_per_strip, strips_per_box,
                                sale_price_unit, sale_price_strip, sale_price_box, stock_units, shortcut_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12)
         RETURNING id, name, manufacturer, barcode, serial_number, form_kind, dosage_form, units_per_strip, strips_per_box, stock_units`,
        [name, f.label, kind, manufacturer, barcode, serial, ups, spb, unitPrice, stripPrice, boxCol, shortcut]);
    } catch (err) {
      if (err && err.code === '23505') return res.status(409).json({ error: /shortcut/i.test(String(err.constraint || '')) ? 'كلمة الاختصار دي مستخدمة في صنف تاني' : 'الباركود ده مستخدم لصنف تاني' });
      throw err;
    }
    await logActivity(req, { action: 'إضافة صنف جديد', entityType: 'medicine', entityId: row.id, details: { medicine_name: name, from: 'batches' } });
    res.json({ medicine: shapeMed(row) });
  } catch (err) { next(err); }
});

// أنواع المنتجات لفورم إضافة الصنف
router.get('/api/forms', (req, res) => {
  res.json({ forms: FORM_ORDER.map((k) => ({ key: k, label: FORMS[k].label, counted: !!FORMS[k].counted, strip: !!FORMS[k].strip, unit: FORMS[k].unit })) });
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
      cost: Number(i.cost), discount_percent: i.discount_percent === undefined || String(i.discount_percent).trim() === '' ? 0 : Number(i.discount_percent), expiry_date: parseDateStrict(String(i.expiry_date || '')), batch_number: i.batch_number ? String(i.batch_number).slice(0, 80) : null
    }));
    items.forEach((i, idx) => {
      if (!i.medicine_id) throw new BusinessError(`البند رقم ${idx + 1}: اختار الصنف من القائمة`);
      if (!Number.isInteger(i.quantity) || i.quantity <= 0) throw new BusinessError(`البند رقم ${idx + 1}: الكمية لازم تكون رقم صحيح أكبر من صفر`);
      if (!Number.isFinite(i.cost) || i.cost < 0) throw new BusinessError(`البند رقم ${idx + 1}: السعر غير صحيح`);
      if (!Number.isFinite(i.discount_percent) || i.discount_percent < 0 || i.discount_percent > 100) throw new BusinessError(`البند رقم ${idx + 1}: نسبة خصم الصنف لازم تكون بين 0 و 100`);
      if (!i.expiry_date) throw new BusinessError(`البند رقم ${idx + 1}: تاريخ الصلاحية مطلوب`);
    });
    const invoiceDate = b.invoice_date ? parseDateStrict(b.invoice_date) : null;
    const dueDate = b.due_date ? parseDateStrict(b.due_date) : null;
    if (b.invoice_date && !invoiceDate) throw new BusinessError('تاريخ الفاتورة غير صحيح');
    if (b.due_date && !dueDate) throw new BusinessError('تاريخ الاستحقاق غير صحيح');
    const paid = parseMoney(b.paid_amount, 'المبلغ المدفوع');
    const method = ['cash', 'bank', 'other'].includes(b.method) ? b.method : 'cash';
    const discount = b.discount_percent === undefined || String(b.discount_percent).trim() === '' ? 0 : Number(b.discount_percent);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new BusinessError('نسبة الخصم لازم تكون بين 0 و 100');

    const row = await queryOne(
      `SELECT create_purchase_invoice($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) AS id`,
      [supplierId, (b.invoice_number || '').slice(0, 80), invoiceDate, dueDate, (b.notes || '').slice(0, 500),
       req.session.userId, req.session.username, JSON.stringify(items), paid, method, cleanKey(b.idempotency_key), discount]
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


// ============ طباعة فاتورة الطلبية ============
router.get('/:id/print', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).render('error', { code: 404, message: 'الفاتورة غير موجودة' });
    const invoice = await queryOne(`
      SELECT pi.*, s.name AS supplier_name, s.company AS supplier_company, s.rep_name, s.phone AS supplier_phone,
             u.full_name AS created_by_name, (pi.total_amount - pi.paid_amount) AS remaining
      FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id LEFT JOIN users u ON u.id = pi.created_by
      WHERE pi.id = $1`, [id]);
    if (!invoice) return res.status(404).render('error', { code: 404, message: 'الفاتورة غير موجودة' });
    const items = await query(
      `SELECT i.*, m.name AS medicine_name, m.serial_number, m.barcode, m.form_kind, m.units_per_strip, m.strips_per_box
       FROM purchase_invoice_items i JOIN medicines m ON m.id = i.medicine_id WHERE i.invoice_id = $1 ORDER BY i.id`, [id]);
    res.render('purchase-print', { invoice, items, unitLabel: require('../lib/drug-form').unitLabel });
  } catch (err) { next(err); }
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
