// routes/stocktake.js
// الجرد الدوري: لقطة بالمخزون ← عدّ فعلي (يدوي أو بالباركود) ← مراجعة الفروق بالقيمة ← اعتماد.
// الاعتماد بيضبط المخزون عن طريق adjust_medicine_stock (نفس سجل التسويات والتدقيق).
// العدّ: أدمن + صيدلي. الاعتماد/الإلغاء: أدمن فقط.
const express = require('express');
const { query, queryOne } = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { isBusinessError, statusFor, userMessage } = require('../lib/errors');

const router = express.Router();
router.use(requireRole('admin', 'pharmacist'));

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
};

router.get('/', async (req, res, next) => {
  try {
    const [stocktakes, categories] = await Promise.all([
      query(`SELECT s.*, u.username AS created_by_name,
               (SELECT COUNT(*)::int FROM stocktake_items WHERE stocktake_id = s.id) AS items,
               (SELECT COUNT(*)::int FROM stocktake_items WHERE stocktake_id = s.id AND counted_units IS NOT NULL) AS counted
             FROM stocktakes s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT 50`),
      query(`SELECT category, COUNT(*)::int AS n FROM medicines WHERE is_active = true AND category IS NOT NULL GROUP BY category ORDER BY n DESC`)
    ]);
    res.render('stocktake', { stocktakes, categories, error: req.query.err || null, active: 'stocktake' });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT start_stocktake($1, $2, $3, $4) AS id', [
      req.body.name, req.body.category, req.session.userId, req.session.username || null
    ]);
    res.redirect('/stocktake/' + row.id);
  } catch (err) {
    if (isBusinessError(err)) return res.redirect('/stocktake?err=' + encodeURIComponent(userMessage(err)));
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const st = id ? await queryOne('SELECT s.*, u.username AS created_by_name FROM stocktakes s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1', [id]) : null;
    if (!st) return res.status(404).render('error', { code: 404, message: 'الجرد غير موجود' });

    const view = ['uncounted', 'variance', 'all'].includes(req.query.view) ? req.query.view : (st.status === 'open' ? 'uncounted' : 'variance');
    const q = (req.query.q || '').trim();
    const params = [id];
    let where = 'si.stocktake_id = $1';
    if (view === 'uncounted') where += ' AND si.counted_units IS NULL';
    if (view === 'variance') where += ' AND si.counted_units IS NOT NULL AND si.counted_units <> si.system_units';
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      where += ` AND (m.name ILIKE $${params.length} OR m.generic_name ILIKE $${params.length} OR m.barcode = $${params.length + 1})`;
      params.push(q);
    }

    const items = await query(
      `SELECT si.*, m.name, m.barcode, m.stock_units AS current_units, m.units_per_strip, m.strips_per_box
       FROM stocktake_items si JOIN medicines m ON m.id = si.medicine_id
       WHERE ${where}
       ORDER BY lower(m.name) LIMIT 300`,
      params
    );

    const totals = await queryOne(
      `SELECT COUNT(*)::int AS items,
              COUNT(*) FILTER (WHERE counted_units IS NOT NULL)::int AS counted,
              COUNT(*) FILTER (WHERE counted_units IS NOT NULL AND counted_units <> system_units)::int AS variances,
              COALESCE(SUM((counted_units - system_units) * cost_unit) FILTER (WHERE counted_units > system_units), 0) AS gain_value,
              COALESCE(SUM((system_units - counted_units) * cost_unit) FILTER (WHERE counted_units < system_units), 0) AS loss_value
       FROM stocktake_items WHERE stocktake_id = $1`, [id]);

    res.render('stocktake-detail', {
      st, items, totals, view, q,
      result: req.query.applied ? (() => { try { return JSON.parse(req.query.applied); } catch (e) { return null; } })() : null,
      error: req.query.err || null, active: 'stocktake'
    });
  } catch (err) {
    next(err);
  }
});

// حفظ عدّ صنف (JSON) — counted فاضي = إلغاء العدّ
router.post('/:id/count', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const medicineId = toInt(req.body.medicine_id);
    const raw = req.body.counted;
    const counted = raw === '' || raw == null ? null : toInt(raw);
    if (!id || !medicineId || (counted !== null && counted < 0) || counted > 10000000) {
      return res.status(400).json({ error: 'قيمة غير صحيحة' });
    }
    const r = await queryOne(
      `UPDATE stocktake_items si SET counted_units = $3, counted_by = $4, counted_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() END
       FROM stocktakes s
       WHERE si.stocktake_id = $1 AND si.medicine_id = $2 AND s.id = si.stocktake_id AND s.status = 'open'
       RETURNING si.counted_units, si.system_units`,
      [id, medicineId, counted, req.session.userId]
    );
    if (!r) return res.status(409).json({ error: 'الجرد مقفول أو الصنف مش ضمنه' });
    res.json({ ok: true, counted: r.counted_units, system: r.system_units });
  } catch (err) {
    console.error('❌ فشل حفظ العدّ:', err);
    res.status(500).json({ error: 'حصل خطأ، حاول تاني' });
  }
});

// مسح باركود: +1 على العدّ (أو +qty)
router.post('/:id/scan', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const barcode = String(req.body.barcode || '').trim();
    const add = Math.min(Math.max(toInt(req.body.add) || 1, 1), 10000);
    if (!id || !barcode) return res.status(400).json({ error: 'باركود غير صحيح' });
    const r = await queryOne(
      `UPDATE stocktake_items si
       SET counted_units = COALESCE(si.counted_units, 0) + $3, counted_by = $4, counted_at = now()
       FROM stocktakes s, medicines m
       WHERE si.stocktake_id = $1 AND s.id = si.stocktake_id AND s.status = 'open'
         AND m.id = si.medicine_id AND (m.barcode = $2 OR m.serial_number = $2)
       RETURNING si.medicine_id, si.counted_units, m.name`,
      [id, barcode, add, req.session.userId]
    );
    if (!r) return res.status(404).json({ error: 'الباركود ده مش ضمن الجرد أو الجرد مقفول' });
    res.json({ ok: true, medicine_id: r.medicine_id, name: r.name, counted: r.counted_units });
  } catch (err) {
    console.error('❌ فشل مسح الباركود:', err);
    res.status(500).json({ error: 'حصل خطأ، حاول تاني' });
  }
});

router.post('/:id/apply', requireRole('admin'), async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(404).send('الجرد غير موجود');
    const row = await queryOne('SELECT apply_stocktake($1, $2, $3) AS result', [id, req.session.userId, req.session.username || null]);
    await logActivity(req, { action: 'اعتماد جرد (ملخص)', entityType: 'stocktake', entityId: id, details: row.result });
    res.redirect(`/stocktake/${id}?view=variance&applied=${encodeURIComponent(JSON.stringify(row.result))}`);
  } catch (err) {
    if (isBusinessError(err)) return res.redirect(`/stocktake/${req.params.id}?err=${encodeURIComponent(userMessage(err))}`);
    next(err);
  }
});

router.post('/:id/cancel', requireRole('admin'), async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(404).send('الجرد غير موجود');
    await query(`UPDATE stocktakes SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [id]);
    await logActivity(req, { action: 'إلغاء جرد', entityType: 'stocktake', entityId: id });
    res.redirect('/stocktake');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
