// routes/shifts.js
// الورديات والخزنة: الحسابات (المتوقع / العجز / الزيادة) كلها في دوال قاعدة البيانات
// (shift_summary / record_shift_cash / close_shift) من حركات الخزنة الفعلية cash_movements.
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { isBusinessError, statusFor, userMessage } = require('../lib/errors');
router.use(requireLogin);

// تاريخ ووقت "دلوقتي" بتوقيت الصيدلية (مش UTC بتاع السيرفر) — للحضور والانصراف
async function pharmacyNow() {
  const r = await queryOne(
    `SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE pharmacy_tz(), 'HH24:MI') AS t`
  );
  return { date: r.d, time: r.t };
}

function sendError(res, err, next) {
  if (isBusinessError(err)) return res.status(statusFor(err)).send(userMessage(err));
  return next(err);
}

// مبلغ صالح (رقم محدود، غير سالب) أو null
function parseMoney(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e10 ? Math.round(n * 100) / 100 : null;
}

// عرض صفحة إدارة الوردية + آخر الورديات المغلقة
router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const activeShift = await queryOne(
      'SELECT * FROM shifts WHERE opened_by = $1 AND closed_at IS NULL',
      [userId]
    );
    let summary = null;
    let liveSalesTotal = 0;
    if (activeShift) {
      summary = await queryOne('SELECT * FROM shift_summary($1)', [activeShift.id]);
      liveSalesTotal = Number(summary.cash_sales) + Number(summary.card_sales) + Number(summary.other_sales);
    }
    const pastShifts = await query(`
      SELECT sh.*, u.full_name AS user_full_name, u.username AS user_username
      FROM shifts sh
      JOIN users u ON u.id = sh.opened_by
      WHERE sh.closed_at IS NOT NULL
      ORDER BY sh.id DESC
      LIMIT 15
    `);
    res.render('shifts', { activeShift, summary, liveSalesTotal, pastShifts, active: 'shifts' });
  } catch (err) {
    next(err);
  }
});

// فتح وردية جديدة
router.post('/start', async (req, res, next) => {
  const userId = req.session.userId;
  try {
    const opening = parseMoney(req.body.opening_balance === '' ? '0' : req.body.opening_balance);
    if (opening === null) return res.status(400).send('المبلغ الافتتاحي غير صحيح');

    const check = await queryOne('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [userId]);
    if (check) return res.status(400).send('هناك وردية مفتوحة بالفعل!');
    try {
      await query('INSERT INTO shifts (opened_by, opening_balance) VALUES ($1, $2)', [userId, opening]);
    } catch (e) {
      if (e.code === '23505') return res.status(400).send('هناك وردية مفتوحة بالفعل!');
      throw e;
    }
    await logActivity(req, { action: 'فتح وردية' });

    // تسجيل حضور تلقائي لو اليوزر مربوط بموظف في جدول الرواتب (بتوقيت الصيدلية)
    const user = await queryOne('SELECT employee_id FROM users WHERE id = $1', [userId]);
    if (user && user.employee_id) {
      const now = await pharmacyNow();
      await query(
        `INSERT INTO attendance (employee_id, attendance_date, status, check_in)
         VALUES ($1, $2, 'present', $3)
         ON CONFLICT (employee_id, attendance_date)
         DO UPDATE SET status = 'present', check_in = COALESCE(attendance.check_in, EXCLUDED.check_in)`,
        [user.employee_id, now.date, now.time]
      );
    }

    res.redirect('/shifts');
  } catch (err) {
    next(err);
  }
});

// إيداع / سحب نقدية أثناء الوردية (مسجّل في الخزنة ومحسوب في المتوقع)
router.post('/cash', async (req, res, next) => {
  const userId = req.session.userId;
  try {
    const type = req.body.type;
    if (!['deposit', 'withdrawal'].includes(type)) return res.status(400).send('نوع الحركة غير صحيح');
    const amount = parseMoney(req.body.amount);
    if (amount === null || amount <= 0) return res.status(400).send('المبلغ لازم يكون أكبر من صفر');

    const shift = await queryOne('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [userId]);
    if (!shift) return res.status(400).send('لا توجد وردية مفتوحة');

    await query('SELECT record_shift_cash($1, $2, $3, $4, $5, $6)', [
      shift.id, userId, req.session.username || null, type, amount, req.body.note || null
    ]);
    res.redirect('/shifts');
  } catch (err) {
    sendError(res, err, next);
  }
});

// إغلاق الوردية (المتوقع والعجز/الزيادة بيتحسبوا في قاعدة البيانات، والإغلاق المزدوج مرفوض)
router.post('/close', async (req, res, next) => {
  const userId = req.session.userId;
  try {
    const actual = parseMoney(req.body.closing_balance);
    if (actual === null) return res.status(400).send('المبلغ الفعلي غير صحيح');

    const shift = await queryOne('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [userId]);
    if (!shift) return res.status(400).send('لا توجد وردية مفتوحة لإغلاقها');

    // الوردية بتتقفل في الـ DB (مع تسجيل التدقيق جوه نفس الـ transaction)
    await query('SELECT close_shift($1, $2, $3, $4, $5)', [
      shift.id, userId, req.session.username || null, actual, req.body.close_note || null
    ]);

    // تسجيل انصراف تلقائي لو اليوزر مربوط بموظف في جدول الرواتب (بتوقيت الصيدلية)
    const user = await queryOne('SELECT employee_id FROM users WHERE id = $1', [userId]);
    if (user && user.employee_id) {
      const now = await pharmacyNow();
      await query(
        `INSERT INTO attendance (employee_id, attendance_date, status, check_out)
         VALUES ($1, $2, 'present', $3)
         ON CONFLICT (employee_id, attendance_date)
         DO UPDATE SET check_out = $3`,
        [user.employee_id, now.date, now.time]
      );
    }

    res.redirect('/shifts');
  } catch (err) {
    sendError(res, err, next);
  }
});

module.exports = router;
