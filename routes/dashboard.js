// routes/dashboard.js
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const todayRow = await queryOne(`
      SELECT COALESCE(SUM(si.total), 0) AS revenue,
             COALESCE(SUM(it.total - it.cost_price_unit_snapshot * it.quantity_units), 0) AS profit,
             COUNT(DISTINCT si.id) AS count
      FROM sale_invoices si
      LEFT JOIN sale_items it ON it.invoice_id = si.id
      WHERE si.created_at::date = CURRENT_DATE
    `);

    const monthRow = await queryOne(`
      SELECT COALESCE(SUM(si.total), 0) AS revenue,
             COALESCE(SUM(it.total - it.cost_price_unit_snapshot * it.quantity_units), 0) AS profit,
             COUNT(DISTINCT si.id) AS count
      FROM sale_invoices si
      LEFT JOIN sale_items it ON it.invoice_id = si.id
      WHERE to_char(si.created_at, 'YYYY-MM') = to_char(now(), 'YYYY-MM')
    `);

    const lowStock = await query('SELECT * FROM low_stock_medicines ORDER BY stock_units ASC LIMIT 10');
    const nearExpiry = await query('SELECT * FROM near_expiry_batches LIMIT 10');

    const recentInvoices = await query(`
      SELECT * FROM sale_invoices ORDER BY created_at DESC LIMIT 8
    `);

    const lowStockCountRow = await queryOne('SELECT COUNT(*) AS c FROM low_stock_medicines');
    const nearExpiryCountRow = await queryOne('SELECT COUNT(*) AS c FROM near_expiry_batches');

    res.render('dashboard', {
      today: {
        revenue: Number(todayRow.revenue),
        profit: Number(todayRow.profit),
        count: Number(todayRow.count)
      },
      month: {
        revenue: Number(monthRow.revenue),
        profit: Number(monthRow.profit),
        count: Number(monthRow.count)
      },
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
