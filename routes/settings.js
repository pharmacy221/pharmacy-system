// routes/settings.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { ACTIONS, DEFAULTS, normalizeCombo, getShortcuts, saveShortcuts } = require('../lib/shortcuts');

const router = express.Router();
router.use(requireLogin);
router.use(requireAdmin);

// بيانات الاختصارات متاحة لكل render في صفحة الإعدادات (حتى لو رجع بخطأ)
router.use(async (req, res, next) => {
  try {
    const keys = await getShortcuts(true);
    res.locals.shortcutActions = ACTIONS;
    res.locals.shortcutDefaults = DEFAULTS;
    res.locals.shortcutKeys = keys;
    res.locals.scConfig = { keys, nav: res.locals.scConfig ? res.locals.scConfig.nav : {} };
    next();
  } catch (err) {
    next(err);
  }
});

async function getPharmacySettings() {
  const rows = await query(`SELECT key, value FROM settings WHERE key IN ('pharmacy_name', 'pharmacy_phone', 'pharmacy_address')`);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    name: map.pharmacy_name || '',
    phone: map.pharmacy_phone || '',
    address: map.pharmacy_address || ''
  };
}

async function getEmployees() {
  return query(`
    SELECT u.id, u.username, u.full_name, u.role, u.created_at, u.employee_id, e.name AS employee_name
    FROM users u
    LEFT JOIN employees e ON e.id = u.employee_id
    WHERE u.role != 'admin'
    ORDER BY u.created_at DESC
  `);
}

async function getPayrollEmployees() {
  return query(`SELECT id, name FROM employees WHERE is_active = true ORDER BY lower(name)`);
}

router.get('/', async (req, res, next) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const employees = await getEmployees();
    const payrollEmployees = await getPayrollEmployees();
    const pharmacySettings = await getPharmacySettings();
    const msgs = { sc_saved: 'تم حفظ الاختصارات', sc_reset: 'تم الرجوع للاختصارات الافتراضية' };
    res.render('settings', {
      user, employees, payrollEmployees, pharmacySettings,
      error: req.query.sc_error ? String(req.query.sc_error).slice(0, 200) : null,
      success: msgs[req.query.msg] || null,
      active: 'settings'
    });
  } catch (err) {
    next(err);
  }
});

// حفظ اختصارات الكيبورد (الفورم بيبعت sc_<id> لكل إجراء؛ الفاضي = الاختصار معطّل)
router.post('/shortcuts', async (req, res, next) => {
  try {
    if (req.body.reset === '1') {
      await saveShortcuts({ ...DEFAULTS });
      await logActivity(req, { action: 'إرجاع اختصارات الكيبورد للافتراضي', entityType: 'settings' });
      return res.redirect('/settings?msg=sc_reset#shortcuts');
    }
    const map = {};
    const used = new Map();
    for (const a of ACTIONS) {
      const n = normalizeCombo(req.body['sc_' + a.id]);
      if (n === null) {
        return res.redirect('/settings?sc_error=' + encodeURIComponent(`الاختصار "${req.body['sc_' + a.id]}" غير صالح (${a.label}). الحروف والأرقام لازم معاها Ctrl أو Alt`) + '#shortcuts');
      }
      if (n) {
        if (used.has(n)) {
          return res.redirect('/settings?sc_error=' + encodeURIComponent(`الاختصار ${n} مكرر في "${used.get(n)}" و"${a.label}"`) + '#shortcuts');
        }
        used.set(n, a.label);
      }
      map[a.id] = n;
    }
    await saveShortcuts(map);
    await logActivity(req, { action: 'تعديل اختصارات الكيبورد', entityType: 'settings' });
    res.redirect('/settings?msg=sc_saved#shortcuts');
  } catch (err) {
    next(err);
  }
});

// حفظ اسم/تليفون/عنوان الصيدلية (بيظهروا في الفاتورة)
router.post('/shop-info', async (req, res, next) => {
  try {
    const { name, phone, address } = req.body;
    const entries = [
      ['pharmacy_name', name || null],
      ['pharmacy_phone', phone || null],
      ['pharmacy_address', address || null]
    ];
    for (const [key, value] of entries) {
      await query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, value]
      );
    }
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/password', async (req, res, next) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const employees = await getEmployees();
    const payrollEmployees = await getPayrollEmployees();
    const pharmacySettings = await getPharmacySettings();

    if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
      return res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: 'كلمة المرور الحالية غير صحيحة', success: null, active: 'settings' });
    }
    if (!new_password || new_password.length < 8) {
      return res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: 'كلمة المرور الجديدة لازم تكون 8 حروف على الأقل', success: null, active: 'settings' });
    }
    if (new_password !== confirm_password) {
      return res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: 'كلمة المرور الجديدة وتأكيدها مش متطابقين', success: null, active: 'settings' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: null, success: 'تم تغيير كلمة المرور بنجاح', active: 'settings' });
  } catch (err) {
    next(err);
  }
});

router.post('/employees/add', async (req, res, next) => {
  try {
    const { username, full_name, password, role, employee_id } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const employees = await getEmployees();
    const payrollEmployees = await getPayrollEmployees();
    const pharmacySettings = await getPharmacySettings();

    if (!username || !password || password.length < 6) {
      return res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: 'اكتب اسم مستخدم وكلمة مرور 6 حروف على الأقل', success: null, active: 'settings' });
    }
    const finalRole = ['pharmacist', 'cashier'].includes(role) ? role : 'cashier';

    const existing = await queryOne('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (existing) {
      return res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: 'اسم المستخدم ده مستخدم قبل كده', success: null, active: 'settings' });
    }

    const hash = bcrypt.hashSync(password, 10);
    await query(
      `INSERT INTO users (username, password_hash, full_name, role, employee_id) VALUES ($1, $2, $3, $4, $5)`,
      [username.trim(), hash, full_name || username.trim(), finalRole, employee_id || null]
    );
    await logActivity(req, { action: 'إضافة موظف', entityType: 'user', details: { username: username.trim(), role: finalRole } });
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

// ربط/تعديل الموظف (من جدول الرواتب) المرتبط بحساب دخول موجود
router.post('/employees/:id/link', async (req, res, next) => {
  try {
    const { employee_id } = req.body;
    await query('UPDATE users SET employee_id = $1 WHERE id = $2 AND role != $3', [employee_id || null, req.params.id, 'admin']);
    await logActivity(req, { action: 'ربط موظف بحساب دخول', entityType: 'user', entityId: req.params.id });
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/employees/:id/reset-password', async (req, res, next) => {
  try {
    const { new_password } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const employees = await getEmployees();
    const payrollEmployees = await getPayrollEmployees();
    const pharmacySettings = await getPharmacySettings();

    if (!new_password || new_password.length < 6) {
      return res.render('settings', { user, employees, payrollEmployees, pharmacySettings, error: 'كلمة مرور الموظف الجديدة لازم تكون 6 حروف على الأقل', success: null, active: 'settings' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2 AND role != $3', [hash, req.params.id, 'admin']);
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/employees/:id/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM users WHERE id = $1 AND role != $2', [req.params.id, 'admin']);
    await logActivity(req, { action: 'حذف موظف', entityType: 'user', entityId: req.params.id });
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
