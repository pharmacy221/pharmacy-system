// routes/customers.js
// ملف العملاء: بحث سريع للكاشير، حساب آجل (مديونية + سداد + كشف حساب)، وتذكيرات إعادة صرف الأدوية المزمنة.
// الصلاحيات: أي مستخدم مسجّل يشوف ويضيف عميل ويسجّل سداد. حد الآجل / التسوية / الإيقاف = أدمن فقط.
const crypto = require('crypto');
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { isBusinessError, statusFor, userMessage, cleanKey } = require('../lib/errors');
const { digitsOf, waLink } = require('../lib/phone');
const { dueRefills, suggestedRefills } = require('../lib/refills');

const router = express.Router();
router.use(requireLogin);

const isAdmin = (req) => req.session && req.session.role === 'admin';
const money = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;
const cleanText = (v, max = 200) => {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  return s || null;
};
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
};
const back = (res, id, params) => res.redirect(`/customers/${id}?${new URLSearchParams(params).toString()}`);

const MESSAGES = {
  saved: 'تم الحفظ',
  paid: 'تم تسجيل السداد',
  adjusted: 'تم تسجيل قيد التسوية',
  refill_added: 'تمت إضافة التذكير',
  refill_removed: 'تم حذف التذكير',
  snoozed: 'تم تأجيل التذكير'
};

// ---------------------------------------------------------------- القائمة
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const filter = ['debt', 'inactive'].includes(req.query.filter) ? req.query.filter : '';
    const params = [];
    const conds = [];
    if (q) {
      const digits = digitsOf(q);
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      let cond = `c.name ILIKE $${params.length}`;
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        cond += ` OR regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $${params.length}`;
      }
      conds.push(`(${cond})`);
    }
    if (filter === 'debt') conds.push('c.balance > 0');
    if (filter === 'inactive') conds.push('c.is_active = false');
    else conds.push('c.is_active = true');

    const customers = await query(
      `SELECT c.*,
         (SELECT MAX(i.created_at) FROM sale_invoices i WHERE i.customer_id = c.id AND i.status = 'completed') AS last_visit,
         (SELECT COUNT(*)::int FROM sale_invoices i WHERE i.customer_id = c.id AND i.status = 'completed') AS visits,
         (SELECT COALESCE(SUM(i.total), 0) FROM sale_invoices i WHERE i.customer_id = c.id AND i.status = 'completed') AS total_spent
       FROM customers c
       WHERE ${conds.join(' AND ')}
       ORDER BY ${filter === 'debt' ? 'c.balance DESC' : 'last_visit DESC NULLS LAST, c.id DESC'}
       LIMIT 300`,
      params
    );

    const stats = await queryOne(
      `SELECT COUNT(*) FILTER (WHERE is_active)::int AS customers,
              COUNT(*) FILTER (WHERE is_active AND balance > 0)::int AS debtors,
              COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS total_debt
       FROM customers`
    );
    const due = await dueRefills({ withinDays: 0 });

    res.render('customers', {
      customers, stats, dueCount: due.length, q, filter,
      error: req.query.err || null, msg: MESSAGES[req.query.msg] || null,
      active: 'customers'
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- بحث الكاشير (JSON)
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const digits = digitsOf(q);
    const params = [`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`];
    let cond = 'c.name ILIKE $1';
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      cond += ` OR regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $2`;
    }
    const rows = await query(
      `SELECT c.id, c.name, c.phone, c.balance, c.credit_limit
       FROM customers c WHERE c.is_active AND (${cond})
       ORDER BY (SELECT MAX(i.created_at) FROM sale_invoices i WHERE i.customer_id = c.id) DESC NULLS LAST, c.name
       LIMIT 8`,
      params
    );
    const due = rows.length ? await dueRefills({ withinDays: 3, customerIds: rows.map((r) => r.id), limit: 100 }) : [];
    res.json({
      results: rows.map((r) => ({
        ...r,
        available_credit: Math.max(0, money(r.credit_limit) - money(r.balance)),
        refills: due.filter((d) => d.customer_id === r.id).slice(0, 6)
          .map((d) => ({ medicine_id: d.medicine_id, name: d.medicine_name, days_overdue: d.days_overdue }))
      }))
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- تذكيرات إعادة الصرف
router.get('/refills', async (req, res, next) => {
  try {
    const horizon = Math.min(Math.max(toInt(req.query.days) ?? 7, 0), 60);
    const [due, suggestions, pharmacyName] = await Promise.all([
      dueRefills({ withinDays: horizon }),
      suggestedRefills(30),
      queryOne(`SELECT value FROM settings WHERE key = 'pharmacy_name'`)
    ]);
    const shop = (pharmacyName && pharmacyName.value) || 'الصيدلية';
    const items = due.map((d) => {
      const when = d.days_overdue > 0 ? 'عدّى ميعاده' : d.days_overdue === 0 ? 'ميعاده النهارده' : 'قرّب ميعاده';
      const text = `أهلاً ${d.customer_name} 👋\nمعاك ${shop}. ${d.medicine_name} ${when}. تحب نجهّزهولك؟`;
      return { ...d, wa: waLink(d.customer_phone, text) };
    });
    res.render('customer-refills', {
      items, suggestions, horizon,
      msg: MESSAGES[req.query.msg] || null, active: 'customers'
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- إضافة عميل
router.post('/', async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 120);
    if (!name) return res.redirect('/customers?err=' + encodeURIComponent('اسم العميل مطلوب'));
    const phone = cleanText(req.body.phone, 30);
    if (phone && digitsOf(phone).length < 7) return res.redirect('/customers?err=' + encodeURIComponent('رقم التليفون غير صحيح'));
    const limit = isAdmin(req) ? Math.max(money(req.body.credit_limit), 0) : 0;
    try {
      const row = await queryOne(
        `INSERT INTO customers (name, phone, address, notes, credit_limit, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, phone, cleanText(req.body.address), cleanText(req.body.notes, 500), limit, req.session.userId]
      );
      await logActivity(req, { action: 'إضافة عميل', entityType: 'customer', entityId: row.id, details: { customer_name: name } });
      return res.redirect(`/customers/${row.id}?msg=saved`);
    } catch (err) {
      if (err.code === '23505') {
        const dup = await queryOne(`SELECT id, name FROM customers WHERE regexp_replace(phone, '\\D', '', 'g') = $1`, [digitsOf(phone)]);
        return res.redirect('/customers?err=' + encodeURIComponent(`رقم التليفون ده مسجّل قبل كده للعميل "${dup ? dup.name : ''}"`));
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- صفحة العميل
router.get('/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const customer = id ? await queryOne('SELECT * FROM customers WHERE id = $1', [id]) : null;
    if (!customer) return res.status(404).render('error', { code: 404, message: 'العميل غير موجود' });

    const [ledger, invoices, topMeds, refills, stats, activeShift] = await Promise.all([
      query(`SELECT l.*, u.username FROM customer_ledger l LEFT JOIN users u ON u.id = l.created_by
             WHERE l.customer_id = $1 ORDER BY l.id DESC LIMIT 100`, [id]),
      query(`SELECT id, created_at, total, credit_amount, status FROM sale_invoices
             WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]),
      query(`SELECT si.medicine_id, si.medicine_name_snapshot AS name, SUM(si.quantity_units)::int AS units,
                    COUNT(DISTINCT i.id)::int AS times,
                    to_char(MAX(pharmacy_date(i.created_at)), 'YYYY-MM-DD') AS last_date
             FROM sale_items si JOIN sale_invoices i ON i.id = si.invoice_id
             WHERE i.customer_id = $1 AND i.status = 'completed' AND si.medicine_id IS NOT NULL
             GROUP BY si.medicine_id, si.medicine_name_snapshot
             ORDER BY times DESC, units DESC LIMIT 10`, [id]),
      // كل تذكيرات العميل (حتى المؤجّلة) لعرضها في صفحته
      query(
        `SELECT r.id, r.medicine_id, r.interval_days, r.notes, to_char(r.snoozed_until, 'YYYY-MM-DD') AS snoozed_until,
                m.name AS medicine_name,
                to_char(COALESCE(l.last_date, r.start_date), 'YYYY-MM-DD') AS last_date,
                to_char(COALESCE(l.last_date, r.start_date) + r.interval_days, 'YYYY-MM-DD') AS next_due,
                (pharmacy_today() - (COALESCE(l.last_date, r.start_date) + r.interval_days))::int AS days_overdue
         FROM customer_refills r JOIN medicines m ON m.id = r.medicine_id
         LEFT JOIN LATERAL (
           SELECT MAX(pharmacy_date(i.created_at)) AS last_date FROM sale_invoices i JOIN sale_items si ON si.invoice_id = i.id
           WHERE i.customer_id = r.customer_id AND i.status = 'completed' AND si.medicine_id = r.medicine_id) l ON true
         WHERE r.customer_id = $1 AND r.is_active ORDER BY 8`, [id]),
      queryOne(`SELECT COUNT(*)::int AS visits, COALESCE(SUM(total), 0) AS spent,
                       to_char(MAX(pharmacy_date(created_at)), 'YYYY-MM-DD') AS last_visit
                FROM sale_invoices WHERE customer_id = $1 AND status = 'completed'`, [id]),
      queryOne('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [req.session.userId])
    ]);

    res.render('customer-detail', {
      customer, ledger, invoices, topMeds, refills, stats, activeShift,
      wa: waLink(customer.phone, ''),
      payKey: crypto.randomUUID(),
      error: req.query.err || null, msg: MESSAGES[req.query.msg] || null,
      active: 'customers'
    });
  } catch (err) {
    next(err);
  }
});

// كشف حساب قابل للطباعة
router.get('/:id/statement', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const customer = id ? await queryOne('SELECT * FROM customers WHERE id = $1', [id]) : null;
    if (!customer) return res.status(404).render('error', { code: 404, message: 'العميل غير موجود' });
    const ledger = await query(
      `SELECT l.*, u.username FROM customer_ledger l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.customer_id = $1 ORDER BY l.id ASC`, [id]);
    const shop = await queryOne(`SELECT value FROM settings WHERE key = 'pharmacy_name'`);
    res.render('customer-statement', { customer, ledger, shopTitle: (shop && shop.value) || 'الصيدلية' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- تعديل
router.post('/:id/update', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const name = cleanText(req.body.name, 120);
    if (!id) return res.status(404).send('العميل غير موجود');
    if (!name) return back(res, id, { err: 'اسم العميل مطلوب' });
    const phone = cleanText(req.body.phone, 30);
    if (phone && digitsOf(phone).length < 7) return back(res, id, { err: 'رقم التليفون غير صحيح' });

    const sets = ['name = $1', 'phone = $2', 'address = $3', 'notes = $4'];
    const params = [name, phone, cleanText(req.body.address), cleanText(req.body.notes, 500)];
    if (isAdmin(req)) {
      params.push(Math.max(money(req.body.credit_limit), 0));
      sets.push(`credit_limit = $${params.length}`);
      params.push(req.body.is_active === 'on');
      sets.push(`is_active = $${params.length}`);
    }
    params.push(id);
    try {
      const r = await query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
      if (!r.length) return res.status(404).send('العميل غير موجود');
    } catch (err) {
      if (err.code === '23505') return back(res, id, { err: 'رقم التليفون ده مسجّل لعميل تاني' });
      throw err;
    }
    await logActivity(req, { action: 'تعديل بيانات عميل', entityType: 'customer', entityId: id, details: { customer_name: name } });
    back(res, id, { msg: 'saved' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- سداد
router.post('/:id/payment', async (req, res, next) => {
  const id = toInt(req.params.id);
  try {
    if (!id) return res.status(404).send('العميل غير موجود');
    await query('SELECT record_customer_payment($1, $2, $3, $4, $5, $6, $7)', [
      id, money(req.body.amount), req.body.method || 'cash', req.body.note || null,
      req.session.userId, req.session.username || null, cleanKey(req.body.idempotency_key)
    ]);
    back(res, id, { msg: 'paid' });
  } catch (err) {
    if (isBusinessError(err)) return back(res, id, { err: userMessage(err) });
    next(err);
  }
});

// ---------------------------------------------------------------- تسوية رصيد (أدمن)
router.post('/:id/adjust', requireRole('admin'), async (req, res, next) => {
  const id = toInt(req.params.id);
  try {
    if (!id) return res.status(404).send('العميل غير موجود');
    // اتجاه التسوية: increase = زوّد المديونية (رصيد افتتاحي / خطأ)، decrease = نقّص المديونية (خصم / إعفاء)
    const amount = money(req.body.amount);
    const delta = req.body.direction === 'decrease' ? -amount : amount;
    await query('SELECT adjust_customer_balance($1, $2, $3, $4, $5)', [
      id, delta, req.body.reason, req.session.userId, req.session.username || null
    ]);
    back(res, id, { msg: 'adjusted' });
  } catch (err) {
    if (isBusinessError(err)) return back(res, id, { err: userMessage(err) });
    next(err);
  }
});

// ---------------------------------------------------------------- تذكيرات الصرف
router.post('/:id/refills', async (req, res, next) => {
  const id = toInt(req.params.id);
  try {
    const medicineId = toInt(req.body.medicine_id);
    const days = toInt(req.body.interval_days);
    if (!id) return res.status(404).send('العميل غير موجود');
    if (!medicineId) return back(res, id, { err: 'اختار الصنف' });
    if (!days || days < 5 || days > 365) return back(res, id, { err: 'المدة لازم تكون بين 5 و365 يوم' });
    const med = await queryOne('SELECT id FROM medicines WHERE id = $1', [medicineId]);
    if (!med) return back(res, id, { err: 'الصنف غير موجود' });
    await query(
      `INSERT INTO customer_refills (customer_id, medicine_id, interval_days, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, medicine_id)
       DO UPDATE SET interval_days = EXCLUDED.interval_days, notes = EXCLUDED.notes, is_active = true, snoozed_until = NULL`,
      [id, medicineId, days, cleanText(req.body.notes, 300), req.session.userId]
    );
    if (req.body.return_to === 'refills') return res.redirect('/customers/refills?msg=refill_added');
    back(res, id, { msg: 'refill_added' });
  } catch (err) {
    next(err);
  }
});

router.post('/refills/:rid/delete', async (req, res, next) => {
  try {
    const rid = toInt(req.params.rid);
    if (!rid) return res.status(404).send('التذكير غير موجود');
    await query('DELETE FROM customer_refills WHERE id = $1', [rid]);
    res.redirect(req.body.return_to === 'refills' ? '/customers/refills?msg=refill_removed' : `/customers/${toInt(req.body.customer_id) || ''}?msg=refill_removed`);
  } catch (err) {
    next(err);
  }
});

router.post('/refills/:rid/snooze', async (req, res, next) => {
  try {
    const rid = toInt(req.params.rid);
    if (!rid) return res.status(404).send('التذكير غير موجود');
    const days = Math.min(Math.max(toInt(req.body.days) || 3, 1), 60);
    await query(`UPDATE customer_refills SET snoozed_until = pharmacy_today() + $2::int WHERE id = $1`, [rid, days]);
    res.redirect('/customers/refills?msg=snoozed');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
