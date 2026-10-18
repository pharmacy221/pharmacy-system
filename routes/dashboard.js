// routes/dashboard.js
const express = require('express');
const { query, queryOne } = require('../db');
const { pharmacyDates, salesSummary } = require('../lib/sales-reports');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    // نفس دوال التقارير (صافي المبيعات بعد المرتجعات، بدون الملغاة، بتوقيت الصيدلية)
    const d = await pharmacyDates();
    const [todayRow, monthRow] = await Promise.all([
      salesSummary(d.today, d.today),
      salesSummary(d.monthStart, d.today)
    ]);

    const lowStock = await query('SELECT * FROM low_stock_medicines ORDER BY stock_units ASC LIMIT 10');
    const nearExpiry = await query('SELECT * FROM near_expiry_batches LIMIT 10');

    const recentInvoices = await query(`
      SELECT * FROM sale_invoices WHERE status = 'completed' ORDER BY created_at DESC LIMIT 8
    `);

    const lowStockCountRow = await queryOne('SELECT COUNT(*) AS c FROM low_stock_medicines');
    const nearExpiryCountRow = await queryOne('SELECT COUNT(*) AS c FROM near_expiry_batches');

    res.render('dashboard', {
      today: { revenue: todayRow.revenue, profit: todayRow.profit, count: todayRow.count },
      month: { revenue: monthRow.revenue, profit: monthRow.profit, count: monthRow.count },
      lowStock,
      nearExpiry,
      lowStockCount: Number(lowStockCountRow.c),
      nearExpiryCount: Number(nearExpiryCountRow.c),
      recentInvoices,
      active: 'dashboard'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
