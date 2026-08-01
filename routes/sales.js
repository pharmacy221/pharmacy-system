// routes/sales.js
// عرض فواتير البيع (رأس فاتورة + بنودها)
const express = require('express');
const { query, queryOne, getClient } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res, next) => {
  try {
    const invoices = await query(`
      SELECT si.*, u.username AS cashier_username,
        (SELECT COUNT(*) FROM sale_items WHERE invoice_id = si.id) AS items_count,
        (SELECT COALESCE(SUM(total - cost_price_unit_snapshot * quantity_units), 0) FROM sale_items WHERE invoice_id = si.id) AS profit
      FROM sale_invoices si
      LEFT JOIN users u ON u.id = si.created_by
      ORDER BY si.created_at DESC
      LIMIT 200
    `);
    res.render('sales', { invoices, active: 'sales' });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const invoice = await queryOne('SELECT * FROM sale_invoices WHERE id = $1', [req.params.id]);
    if (!invoice) return res.status(404).send('الفاتورة غير موجودة');
    const items = await query('SELECT * FROM sale_items WHERE invoice_id = $1 ORDER BY id', [invoice.id]);
    res.render('sale-detail', { invoice, items, active: 'sales' });
  } catch (err) {
    next(err);
  }
});

// حذف فاتورة (أدمن فقط) - بيرجع كل الكميات المباعة فيها لأقرب تشغيلة صلاحية غير منتهية
router.post('/:id/delete', requireAdmin, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const invoiceResult = await client.query('SELECT * FROM sale_invoices WHERE id = $1', [req.params.id]);
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).send('الفاتورة غير موجودة');
    }

    const itemsResult = await client.query('SELECT * FROM sale_items WHERE invoice_id = $1', [req.params.id]);
    for (const item of itemsResult.rows) {
      if (item.medicine_id) {
        await client.query('UPDATE medicines SET stock_units = stock_units + $1 WHERE id = $2', [item.quantity_units, item.medicine_id]);
        const batchResult = await client.query(
          `SELECT id FROM batches WHERE medicine_id = $1 AND expiry_date >= CURRENT_DATE ORDER BY expiry_date DESC LIMIT 1`,
          [item.medicine_id]
        );
        if (batchResult.rows[0]) {
          await client.query('UPDATE batches SET quantity_units = quantity_units + $1 WHERE id = $2', [item.quantity_units, batchResult.rows[0].id]);
        }
      }
    }

    await client.query('DELETE FROM sale_invoices WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    await logActivity(req, { action: 'حذف فاتورة بيع وإرجاع المخزون', entityType: 'sale_invoice', entityId: req.params.id });
    res.redirect('/sales');
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
