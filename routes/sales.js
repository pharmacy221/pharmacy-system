// routes/sales.js
// عرض فواتير البيع (رأس فاتورة + بنودها) + إلغاء الفاتورة (Void) بدل الحذف النهائي
const express = require('express');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { isBusinessError, statusFor, userMessage } = require('../lib/errors');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res, next) => {
  try {
    // الربح = إجمالي الفاتورة (بعد الخصم) − تكلفة البنود − أثر المرتجعات. الفاتورة الملغاة ربحها صفر.
    const invoices = await query(`
      SELECT si.*, u.username AS cashier_username,
        (SELECT COUNT(*) FROM sale_items WHERE invoice_id = si.id) AS items_count,
        CASE WHEN si.status = 'voided' THEN 0 ELSE
          si.total
          - COALESCE((SELECT SUM(cost_price_unit_snapshot * quantity_units) FROM sale_items WHERE invoice_id = si.id), 0)
          - COALESCE((SELECT SUM(refund_amount - cost_recovered) FROM returns WHERE invoice_id = si.id), 0)
        END AS profit
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
    const id = parseInt(req.params.id, 10);
    const invoice = Number.isInteger(id) ? await queryOne('SELECT * FROM sale_invoices WHERE id = $1', [id]) : null;
    if (!invoice) return res.status(404).send('الفاتورة غير موجودة');
    const items = await query('SELECT * FROM sale_items WHERE invoice_id = $1 ORDER BY id', [invoice.id]);
    res.render('sale-detail', { invoice, items, active: 'sales' });
  } catch (err) {
    next(err);
  }
});

// إلغاء فاتورة (أدمن فقط). مفيش حذف نهائي: الفاتورة الأصلية بتفضل محفوظة بحالة "ملغاة" مع السبب والمستخدم والوقت.
// الإلغاء بيتم كله جوه دالة واحدة في قاعدة البيانات (transaction واحدة):
//   - بيرجّع للمخزون المتبقي بس (المباع − اللي اترجع قبل كده) لنفس التشغيلة، ومبيرجّعش تشغيلة منتهية
//   - بيسجّل رد المبلغ المتبقي في الخزنة، وبيمنع الإلغاء مرتين
// /delete متسابة كمسار قديم لنفس العملية (عشان أي صفحة مفتوحة قديمة متكسرش)، لكنها بقت إلغاء مش حذف.
async function voidInvoice(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('الفاتورة غير موجودة');
    await query('SELECT void_sale_invoice($1, $2, $3, $4, $5) AS result', [
      id,
      req.session.userId,
      req.session.username || null,
      req.body.reason,
      req.body.refund_method || null
    ]);
    res.redirect('/sales');
  } catch (err) {
    if (isBusinessError(err)) return res.status(statusFor(err)).send(userMessage(err));
    next(err);
  }
}
router.post('/:id/void', requireAdmin, voidInvoice);
router.post('/:id/delete', requireAdmin, voidInvoice);

module.exports = router;
