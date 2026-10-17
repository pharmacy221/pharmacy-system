// routes/payroll.js
const express = require('express');
const { query, queryOne, getClient } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

const router = express.Router();
router.use(requireLogin, requireAdmin);

function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// جدول shop_settings مش موجود في قاعدة البيانات — بيانات المحل متخزنة
// في جدول settings بنظام key/value (زي ما هو مستخدم في routes/pos.js).
// الدالة دي بتجيبها وبتبنيها كـ object بنفس الشكل اللي الـ views بتستخدمه (shop.pharmacy_name).
async function getShopSettings() {
  const rows = await query(`SELECT key, value FROM settings`);
  const map = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return {
    pharmacy_name: map.pharmacy_name || null,
    phone: map.pharmacy_phone || null,
    address: map.pharmacy_address || null
  };
}

// ============ قائمة الموظفين ============
router.get('/', async (req, res, next) => {
  try {
    const employees = await query(`
      SELECT e.*,
        COALESCE((SELECT SUM(a.amount) FROM advances a WHERE a.employee_id = e.id AND a.settled = false), 0) AS unsettled_advances
      FROM employees e
      ORDER BY e.is_active DESC, lower(e.name)
    `);

    const totals = await queryOne(`
      SELECT COALESCE(SUM(base_salary), 0) AS total_base_salaries
      FROM employees WHERE is_active = true
    `);

    res.render('payroll', { employees, totals, error: null, active: 'payroll' });
  } catch (err) {
    next(err);
  }
});

router.post('/add', async (req, res, next) => {
  const { name, phone, job_title, base_salary, hire_date, notes } = req.body;
  try {
    if (!name || !name.trim()) return res.status(400).send('اسم الموظف مطلوب');
    await query(
      `INSERT INTO employees (name, phone, job_title, base_salary, hire_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [name.trim(), phone || null, job_title || null, parseFloat(base_salary) || 0, hire_date || null, notes || null]
    );
    await logActivity(req, { action: 'إضافة موظف جديد', entityType: 'employee', details: { name: name.trim() } });
    res.redirect('/payroll');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/update', async (req, res, next) => {
  const { name, phone, job_title, base_salary, hire_date, notes, is_active } = req.body;
  try {
    await query(
      `UPDATE employees SET name=$1, phone=$2, job_title=$3, base_salary=$4, hire_date=$5, notes=$6, is_active=$7 WHERE id=$8`,
      [name.trim(), phone || null, job_title || null, parseFloat(base_salary) || 0, hire_date || null, notes || null, is_active === 'on', req.params.id]
    );
    res.redirect('/payroll');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    // مش بنمسح نهائي عشان تاريخ الحضور والرواتب يفضل سليم، بس بنعطل الموظف
    await query('UPDATE employees SET is_active = false WHERE id = $1', [req.params.id]);
    await logActivity(req, { action: 'إلغاء تفعيل موظف', entityType: 'employee', entityId: req.params.id });
    res.redirect('/payroll');
  } catch (err) {
    next(err);
  }
});

// ============ صفحة تفاصيل موظف: حضور + سلف + سجل قبض + قبض راتب جديد ============
router.get('/:id', async (req, res, next) => {
  try {
    const employee = await queryOne('SELECT * FROM employees WHERE id = $1', [req.params.id]);
    if (!employee) return res.status(404).send('الموظف غير موجود');

    const from = req.query.from || firstOfMonth(new Date());
    const to = req.query.to || todayStr();

    const attendance = await query(
      `SELECT * FROM attendance WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3 ORDER BY attendance_date DESC`,
      [req.params.id, from, to]
    );

    const attendanceStats = await queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'present') AS present_count,
         COUNT(*) FILTER (WHERE status = 'absent') AS absent_count,
         COUNT(*) FILTER (WHERE status = 'leave') AS leave_count,
         COUNT(*) FILTER (WHERE status = 'late') AS late_count
       FROM attendance WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3`,
      [req.params.id, from, to]
    );

    const advancesList = await query(
      `SELECT * FROM advances WHERE employee_id = $1 ORDER BY advance_date DESC, id DESC LIMIT 50`,
      [req.params.id]
    );

    const unsettledAdvancesRow = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM advances WHERE employee_id = $1 AND settled = false`,
      [req.params.id]
    );

    const paymentsHistory = await query(
      `SELECT * FROM salary_payments WHERE employee_id = $1 ORDER BY payment_date DESC, id DESC LIMIT 24`,
      [req.params.id]
    );

    res.render('employee-detail', {
      employee, attendance, attendanceStats, advancesList,
      unsettledAdvances: Number(unsettledAdvancesRow.total),
      paymentsHistory, from, to, error: null, active: 'payroll'
    });
  } catch (err) {
    next(err);
  }
});

// ============ تسجيل حضور يوم (لو مسجل يومها بيتحدث بدل ما يتكرر) ============
router.post('/:id/attendance', async (req, res, next) => {
  const { attendance_date, status, check_in, check_out, notes } = req.body;
  try {
    if (!attendance_date) return res.redirect('/payroll/' + req.params.id);
    await query(
      `INSERT INTO attendance (employee_id, attendance_date, status, check_in, check_out, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (employee_id, attendance_date)
       DO UPDATE SET status = $3, check_in = $4, check_out = $5, notes = $6`,
      [req.params.id, attendance_date, status || 'present', check_in || null, check_out || null, notes || null]
    );
    res.redirect('/payroll/' + req.params.id);
  } catch (err) {
    next(err);
  }
});

// ============ إضافة سلفة ============
router.post('/:id/advances/add', async (req, res, next) => {
  const { amount, advance_date, reason } = req.body;
  try {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).send('قيمة السلفة غير صحيحة');

    await query(
      `INSERT INTO advances (employee_id, amount, advance_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, amt, advance_date || todayStr(), reason || null, req.session.userId]
    );

    await logActivity(req, {
      action: 'صرف سلفة لموظف',
      entityType: 'advance',
      entityId: req.params.id,
      details: { amount: amt }
    });

    res.redirect('/payroll/' + req.params.id);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/advances/:advanceId/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM advances WHERE id = $1 AND employee_id = $2 AND settled = false', [req.params.advanceId, req.params.id]);
    res.redirect('/payroll/' + req.params.id);
  } catch (err) {
    next(err);
  }
});

// ============ قبض الراتب: بيحسب الأساسي + بونص - خصومات - كل السلف الغير مسددة، وبيسجل الدفعة ============
router.post('/:id/pay', async (req, res, next) => {
  const { period_start, period_end, bonus, other_deductions, notes } = req.body;
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const empResult = await client.query('SELECT * FROM employees WHERE id = $1 FOR UPDATE', [req.params.id]);
    const employee = empResult.rows[0];
    if (!employee) {
      await client.query('ROLLBACK');
      return res.status(404).send('الموظف غير موجود');
    }

    const unsettledResult = await client.query(
      'SELECT * FROM advances WHERE employee_id = $1 AND settled = false FOR UPDATE',
      [req.params.id]
    );
    const unsettledAdvances = unsettledResult.rows;
    const totalAdvances = unsettledAdvances.reduce((sum, a) => sum + Number(a.amount), 0);

    const baseSalary = Number(employee.base_salary);
    const bonusAmt = parseFloat(bonus) || 0;
    const deductionsAmt = parseFloat(other_deductions) || 0;
    const netPaid = baseSalary + bonusAmt - deductionsAmt - totalAdvances;

    const paymentResult = await client.query(
      `INSERT INTO salary_payments
        (employee_id, period_start, period_end, base_salary, bonus, other_deductions, advances_deducted, net_paid, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        req.params.id, period_start, period_end, baseSalary, bonusAmt, deductionsAmt,
        totalAdvances, netPaid, notes || null, req.session.userId
      ]
    );
    const paymentId = paymentResult.rows[0].id;

    // كل السلف الغير مسددة بتتقفل وترتبط بعملية القبض دي
    for (const adv of unsettledAdvances) {
      await client.query(
        'UPDATE advances SET settled = true, settled_in_payment_id = $1 WHERE id = $2',
        [paymentId, adv.id]
      );
    }

    await client.query('COMMIT');

    await logActivity(req, {
      action: 'قبض راتب',
      entityType: 'salary_payment',
      entityId: paymentId,
      details: { employee_name: employee.name, net_paid: netPaid }
    });

    res.redirect(`/payroll/${req.params.id}/report/${paymentId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ============ تقرير قبض راتب قابل للطباعة ============
router.get('/:id/report/:paymentId', async (req, res, next) => {
  try {
    const employee = await queryOne('SELECT * FROM employees WHERE id = $1', [req.params.id]);
    const payment = await queryOne('SELECT * FROM salary_payments WHERE id = $1 AND employee_id = $2', [req.params.paymentId, req.params.id]);
    if (!employee || !payment) return res.status(404).send('التقرير غير موجود');

    const settledAdvances = await query(
      'SELECT * FROM advances WHERE settled_in_payment_id = $1 ORDER BY advance_date',
      [req.params.paymentId]
    );

    const shop = await getShopSettings();

    res.render('employee-report', { employee, payment, settledAdvances, shop });
  } catch (err) {
    next(err);
  }
});

// ============ تقرير شامل لموظف عن فترة (كل الحضور + السلف + المدفوعات) قابل للطباعة ============
router.get('/:id/full-report', async (req, res, next) => {
  try {
    const employee = await queryOne('SELECT * FROM employees WHERE id = $1', [req.params.id]);
    if (!employee) return res.status(404).send('الموظف غير موجود');

    const from = req.query.from || firstOfMonth(new Date());
    const to = req.query.to || todayStr();

    const attendance = await query(
      `SELECT * FROM attendance WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3 ORDER BY attendance_date ASC`,
      [req.params.id, from, to]
    );
    const advancesList = await query(
      `SELECT * FROM advances WHERE employee_id = $1 AND advance_date BETWEEN $2 AND $3 ORDER BY advance_date ASC`,
      [req.params.id, from, to]
    );
    const paymentsList = await query(
      `SELECT * FROM salary_payments WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3 ORDER BY payment_date ASC`,
      [req.params.id, from, to]
    );

    const shop = await getShopSettings();

    res.render('employee-full-report', { employee, attendance, advancesList, paymentsList, from, to, shop });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
