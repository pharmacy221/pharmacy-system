// routes/reports.js
// تقارير المبيعات والأرباح + النواقص + قرب انتهاء الصلاحية + الأصناف الأكثر مبيعاً
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireAdmin);

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
}

async function rangeSummary(from, to) {
  const row = await queryOne(`
    SELECT COALESCE(SUM(si.total), 0) AS revenue,
           COALESCE(SUM(it.total - it.cost_price_unit_snapshot * it.quantity_units), 0) AS profit,
           COUNT(DISTINCT si.id) AS count
    FROM sale_invoices si
    LEFT JOIN sale_items it ON it.invoice_id = si.id
    WHERE si.created_at::date BETWEEN $1 AND $2
  `, [from, to]);
  return { revenue: Number(row.revenue), profit: Number(row.profit), count: Number(row.count) };
}

router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || daysAgoStr(13);
    const to = req.query.to || todayStr();

    const [todaySummary, weekSummary, monthSummary, rangeSummaryResult] = await Promise.all([
      rangeSummary(todayStr(), todayStr()),
      rangeSummary(daysAgoStr(6), todayStr()),
      rangeSummary(todayStr().slice(0, 8) + '01', todayStr()),
      rangeSummary(from, to)
    ]);

    const dailySeries = await query(`
      SELECT si.created_at::date AS day,
             COALESCE(SUM(si.total), 0) AS revenue,
             COALESCE(SUM(it.total - it.cost_price_unit_snapshot * it.quantity_units), 0) AS profit
      FROM sale_invoices si
      LEFT JOIN sale_items it ON it.invoice_id = si.id
      WHERE si.created_at::date BETWEEN $1 AND $2
      GROUP BY si.created_at::date
      ORDER BY day ASC
    `, [from, to]);

    const maxRevenue = Math.max(1, ...dailySeries.map((d) => Number(d.revenue)));

    const topMedicines = await query(`
      SELECT si.medicine_name_snapshot AS name, SUM(si.quantity_units) AS units_sold, SUM(si.total) AS revenue
      FROM sale_items si
      JOIN sale_invoices inv ON inv.id = si.invoice_id
      WHERE inv.created_at::date BETWEEN $1 AND $2
      GROUP BY si.medicine_name_snapshot
      ORDER BY units_sold DESC
      LIMIT 10
    `, [from, to]);

    const lowStock = await query('SELECT * FROM low_stock_medicines ORDER BY stock_units ASC');
    const nearExpiry = await query('SELECT * FROM near_expiry_batches');

    res.render('reports', {
      todaySummary, weekSummary, monthSummary,
      rangeSummary: rangeSummaryResult,
      dailySeries, maxRevenue,
      topMedicines, lowStock, nearExpiry,
      from, to,
      active: 'reports'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
