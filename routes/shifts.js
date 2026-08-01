// routes/shifts.js
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
router.use(requireLogin);

// عرض صفحة إدارة الوردية + آخر الورديات المغلقة
router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.userId;

    const activeShift = await queryOne(
      'SELECT * FROM shifts WHERE opened_by = $1 AND closed_at IS NULL',
      [userId]
    );

    let liveSalesTotal = 0;
    if (activeShift) {
      const row = await queryOne(
        `SELECT COALESCE(SUM(total), 0) AS total FROM sale_invoices WHERE created_by = $1 AND created_at >= $2`,
        [userId, activeShift.opened_at]
      );
      liveSalesTotal = Number(row.total);
    }

    const pastShifts = await query(`
      SELECT sh.*, u.full_name AS user_full_name, u.username AS user_username
      FROM shifts sh
      JOIN users u ON u.id = sh.opened_by
      WHERE sh.closed_at IS NOT NULL
      ORDER BY sh.id DESC
      LIMIT 15
    `);

    res.render('shifts', { activeShift, liveSalesTotal, pastShifts, active: 'shifts' });
  } catch (err) {
    next(err);
  }
});

// فتح وردية جديدة
router.post('/start', async (req, res, next) => {
  const { opening_balance } = req.body;
  const userId = req.session.userId;
  try {
    const check = await queryOne('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [userId]);
    if (check) return res.status(400).send('هناك وردية مفتوحة بالفعل!');

    await query('INSERT INTO shifts (opened_by, opening_balance) VALUES ($1, $2)', [userId, Number(opening_balance) || 0]);
    await logActivity(req, { action: 'فتح وردية' });
    res.redirect('/shifts');
  } catch (err) {
    next(err);
  }
});

// إغلاق الوردية
router.post('/close', async (req, res, next) => {
  const { closing_balance } = req.body;
  const userId = req.session.userId;
  try {
    const shift = await queryOne('SELECT * FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [userId]);
    if (!shift) return res.status(400).send('لا توجد وردية مفتوحة لإغلاقها');

    await query(
      `UPDATE shifts SET closing_balance = $1, closed_at = now() WHERE id = $2`,
      [parseFloat(closing_balance) || 0, shift.id]
    );
    await logActivity(req, { action: 'إغلاق وردية', entityType: 'shift', entityId: shift.id });
    res.redirect('/shifts');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
