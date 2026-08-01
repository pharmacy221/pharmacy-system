// routes/reports.js
const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || new Date().toISOString().slice(0, 8) + '01';
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    // بنفصل حساب "إجمالي المبيعات" عن حساب "الربح" في CTEs منفصلة
    // عشان الـ JOIN بين الفاتورة وبنودها ميكررش قيمة sale_invoices.total على كل بند
    // (لو صنف واحد مبيع في فاتورة فيها 3 بنود، غير كده كان هيتجمع total الفاتورة 3 مرات)
    const summary = await query(`
      WITH day_sales AS (
        SELECT sale_invoices.created_at::date AS day,
               SUM(sale_invoices.total) AS sales_total
        FROM sale_invoices
        WHERE sale_invoices.created_at::date BETWEEN $1 AND $2
        GROUP BY sale_invoices.created_at::date
      ),
      day_profit AS (
        SELECT sale_invoices.created_at::date AS day,
               SUM(sale_items.total - (sale_items.cost_price_unit_snapshot * sale_items.quantity_units)) AS profit
        FROM sale_items
        JOIN sale_invoices ON sale_invoices.id = sale_items.invoice_id
        WHERE sale_invoices.created_at::date BETWEEN $1 AND $2
        GROUP BY sale_invoices.created_at::date
      )
      SELECT
        COALESCE(day_sales.day, day_profit.day) AS day,
        COALESCE(day_sales.sales_total, 0) AS sales_total,
        COALESCE(day_profit.profit, 0) AS profit
      FROM day_sales
      FULL OUTER JOIN day_profit ON day_profit.day = day_sales.day
      ORDER BY day ASC
    `, [from, to]);

    const topMedicines = await query(`
      SELECT
        sale_items.medicine_name_snapshot AS name,
        SUM(sale_items.quantity_units) AS units_sold,
        SUM(sale_items.total) AS revenue,
        SUM(sale_items.total - (sale_items.cost_price_unit_snapshot * sale_items.quantity_units)) AS profit
      FROM sale_items
      JOIN sale_invoices ON sale_invoices.id = sale_items.invoice_id
      WHERE sale_invoices.created_at::date BETWEEN $1 AND $2
      GROUP BY sale_items.medicine_name_snapshot
      ORDER BY revenue DESC
      LIMIT 15
    `, [from, to]);

    res.render('reports', { summary, topMedicines, from, to });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
