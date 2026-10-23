// routes/official-prices.js
// الأسعار الرسمية: مقارنة سعر بيع كل صنف عندنا بالسعر الرسمي (drug_reference.price_egp)،
// وتطبيق السعر الرسمي (على المحدد أو على الكل) لما التسعيرة تتغير، وسجل بكل تغيّر في الأسعار.
// العرض: أدمن + صيدلي. التطبيق والربط التلقائي: أدمن فقط.
const express = require('express');
const { query, getClient } = require('../db');
const { requireLogin, requireRole, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { currentBox, officialTarget, boxDiff } = require('../lib/official-prices');

const router = express.Router();
router.use(requireLogin);

const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const MSG = {
  applied: (n) => `تم تطبيق السعر الرسمي على ${n} صنف`,
  linked: (n) => `تم ربط ${n} صنف بدليل الأدوية`
};

// الأصناف المربوطة بالدليل (ref_id) ومعاها فرق في سعر العلبة
async function loadLinked({ q, instock }) {
  const params = [];
  let where = 'm.is_active = true AND d.price_egp IS NOT NULL AND d.price_egp > 0';
  if (instock) where += ' AND m.stock_units > 0';
  if (q) {
    params.push(`%${escLike(q)}%`);
    where += ` AND (m.name ILIKE $${params.length} OR m.generic_name ILIKE $${params.length})`;
  }
  const rows = await query(
    `SELECT m.id, m.name, m.manufacturer, m.units_per_strip, m.strips_per_box, m.stock_units,
            m.sale_price_unit, m.sale_price_strip, m.sale_price_box, d.price_egp AS official_box
     FROM medicines m JOIN drug_reference d ON d.id = m.ref_id
     WHERE ${where} ORDER BY lower(m.name)`,
    params
  );
  return rows.map((m) => ({ ...m, current_box: currentBox(m), diff: boxDiff(m, m.official_box) }));
}

router.get('/', requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const instock = req.query.instock === '1';
    const showAll = req.query.show === 'all';
    let all = [];
    let notReady = false;
    try {
      all = await loadLinked({ q, instock });
    } catch (err) {
      if (err.code !== '42P01') throw err; // دليل الأدوية لسه متركّبش
      notReady = true;
    }
    const diffs = all.filter((m) => m.diff !== 0);
    const shown = (showAll ? all : diffs).slice(0, 300);
    const [{ n: unlinked } = { n: 0 }] = notReady ? [{ n: 0 }] : await query(
      `SELECT COUNT(*)::int AS n FROM medicines WHERE is_active = true AND ref_id IS NULL`
    );
    res.render('official-prices', {
      rows: shown, diffCount: diffs.length, linkedCount: all.length, unlinked, notReady,
      q, instock, showAll, canApply: req.session.role === 'admin',
      msg: req.query.msg ? String(req.query.msg).slice(0, 120) : null,
      active: 'official-prices'
    });
  } catch (err) {
    next(err);
  }
});

// تطبيق السعر الرسمي: ids محددة، أو all=1 (على نفس فلاتر الصفحة). كله في transaction واحدة وبيتسجّل في سجل الأسعار.
router.post('/apply', requireAdmin, async (req, res, next) => {
  const client = await getClient();
  let began = false;
  try {
    const q = String(req.body.q || '').trim().slice(0, 80);
    const instock = req.body.instock === '1';
    const linked = await loadLinked({ q, instock });
    let targets = linked.filter((m) => m.diff !== 0);
    if (req.body.all !== '1') {
      const raw = [].concat(req.body.ids || []).flatMap((v) => String(v).split(','));
      const wanted = new Set(raw.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0));
      targets = targets.filter((m) => wanted.has(m.id));
    }
    if (!targets.length) return res.redirect('/official-prices?msg=' + encodeURIComponent('مفيش أصناف متحددة للتطبيق'));

    const t = targets.map((m) => ({ id: m.id, ...officialTarget(m, m.official_box) }));
    await client.query('BEGIN');
    began = true;
    await client.query(`SELECT set_config('app.price_source', 'official', true), set_config('app.user_id', $1, true)`, [String(req.session.userId)]);
    await client.query(
      `UPDATE medicines m SET sale_price_unit = t.unit, sale_price_strip = t.strip, sale_price_box = t.box
       FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::numeric[]) AS t(id, unit, strip, box)
       WHERE m.id = t.id`,
      [t.map((x) => x.id), t.map((x) => x.unit), t.map((x) => x.strip), t.map((x) => x.box)]
    );
    await client.query('COMMIT');
    began = false;
    await logActivity(req, { action: 'تطبيق الأسعار الرسمية', entityType: 'medicine', details: { count: t.length } });
    res.redirect('/official-prices?msg=' + encodeURIComponent(MSG.applied(t.length)));
  } catch (err) {
    if (began) { try { await client.query('ROLLBACK'); } catch (e) { /* الاتصال اتقفل */ } }
    next(err);
  } finally {
    client.release();
  }
});

// ربط الأصناف اللي مالهاش ref_id بدليل الأدوية عن طريق تطابق الاسم (مرة واحدة لكل صنف في الدليل)
router.post('/link-by-name', requireAdmin, async (req, res, next) => {
  try {
    const rows = await query(
      `WITH cand AS (
         SELECT DISTINCT ON (d.id) m.id AS mid, d.id AS did
         FROM medicines m
         JOIN (SELECT DISTINCT ON (lower(name_en)) id, lower(name_en) AS ln FROM drug_reference ORDER BY lower(name_en), id) d
           ON lower(m.name) = d.ln
         WHERE m.ref_id IS NULL AND m.is_active = true
           AND NOT EXISTS (SELECT 1 FROM medicines x WHERE x.ref_id = d.id)
         ORDER BY d.id, m.id)
       UPDATE medicines SET ref_id = cand.did FROM cand WHERE medicines.id = cand.mid RETURNING medicines.id`
    );
    await logActivity(req, { action: 'ربط أصناف بدليل الأدوية', entityType: 'medicine', details: { count: rows.length } });
    res.redirect('/official-prices?msg=' + encodeURIComponent(MSG.linked(rows.length)));
  } catch (err) {
    next(err);
  }
});

// سجل تغيّر الأسعار
router.get('/history', requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) { params.push(`%${escLike(q)}%`); where.push(`h.medicine_name ILIKE $${params.length}`); }
    if (['manual', 'official'].includes(req.query.source)) { params.push(req.query.source); where.push(`h.source = $${params.length}`); }
    const rows = await query(
      `SELECT h.*, u.username FROM price_history h LEFT JOIN users u ON u.id = h.changed_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.id DESC LIMIT 300`,
      params
    );
    res.render('price-history', { rows, q, source: req.query.source || '', active: 'official-prices' });
  } catch (err) {
    if (err.code === '42P01') return res.render('price-history', { rows: [], q: '', source: '', notReady: true, active: 'official-prices' });
    next(err);
  }
});

module.exports = router;
