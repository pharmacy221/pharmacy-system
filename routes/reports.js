// routes/reports.js
// تقارير المبيعات والأرباح + النواقص + قرب انتهاء الصلاحية + الأصناف الأكثر مبيعاً
// الأرقام من دوال قاعدة البيانات report_* (نفس مصدر الداشبورد): صافي المبيعات بعد المرتجعات،
// والفواتير الملغاة مستبعدة، والأيام بتوقيت الصيدلية.
const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { validDate, pharmacyDates, salesSummary, salesDaily, topMedicines } = require('../lib/sales-reports');

const router = express.Router();
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const d = await pharmacyDates();
    let from = validDate(req.query.from) || d.twoWeeksStart;
    let to = validDate(req.query.to) || d.today;
    if (from > to) [from, to] = [to, from];

    const [todaySummary, weekSummary, monthSummary, rangeSummaryResult, dailySeries, topMeds] = await Promise.all([
      salesSummary(d.today, d.today),
      salesSummary(d.weekStart, d.today),
      salesSummary(d.monthStart, d.today),
      salesSummary(from, to),
      salesDaily(from, to),
      topMedicines(from, to, 10)
    ]);

    const maxRevenue = Math.max(1, ...dailySeries.map((r) => r.revenue));

    const lowStock = await query('SELECT * FROM low_stock_medicines ORDER BY stock_units ASC');
    const nearExpiry = await query('SELECT * FROM near_expiry_batches');

    res.render('reports', {
      todaySummary, weekSummary, monthSummary,
      rangeSummary: rangeSummaryResult,
      dailySeries, maxRevenue,
      topMedicines: topMeds, lowStock, nearExpiry,
      from, to,
      active: 'reports'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
