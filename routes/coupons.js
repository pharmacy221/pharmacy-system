// routes/coupons.js
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const coupons = await query('SELECT * FROM coupons ORDER BY id DESC');
    res.render('coupons', { coupons: coupons || [], error: null, active: 'coupons' });
  } catch (err) {
    next(err);
  }
});

router.post('/add', async (req, res, next) => {
  const { code, discount_kind, discount_value, expires_at } = req.body;
  try {
    if (!code || !code.trim()) return res.status(400).send('كود الكوبون مطلوب');
    const value = parseFloat(discount_value);
    if (!value || value <= 0) return res.status(400).send('قيمة الخصم يجب أن تكون أكبر من صفر');

    const isPercent = discount_kind === 'percent';
    await query(
      `INSERT INTO coupons (code, discount_percent, discount_amount, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [
        code.trim().toUpperCase(),
        isPercent ? value : null,
        isPercent ? null : value,
        expires_at ? new Date(expires_at) : null
      ]
    );
    await logActivity(req, { action: 'إضافة كوبون', entityType: 'coupon', details: { code: code.trim().toUpperCase() } });
    res.redirect('/coupons');
  } catch (err) {
    if (err.code === '23505') return res.status(400).send('يوجد كوبون بنفس الكود بالفعل');
    next(err);
  }
});

router.post('/:id/toggle', async (req, res, next) => {
  try {
    await query('UPDATE coupons SET active = NOT active WHERE id = $1', [req.params.id]);
    res.redirect('/coupons');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    await logActivity(req, { action: 'حذف كوبون', entityType: 'coupon', entityId: req.params.id });
    res.redirect('/coupons');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
