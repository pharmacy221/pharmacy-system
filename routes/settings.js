// routes/settings.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

const router = express.Router();
router.use(requireLogin);
router.use(requireAdmin);

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
  return query(`SELECT id, username, full_name, role, created_at FROM users WHERE role != 'admin' ORDER BY created_at DESC`);
}

router.get('/', async (req, res, next) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const employees = await getEmployees();
    const pharmacySettings = await getPharmacySettings();
    res.render('settings', { user, employees, pharmacySettings, error: null, success: null, active: 'settings' });
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
    const pharmacySettings = await getPharmacySettings();

    if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
      return res.render('settings', { user, employees, pharmacySettings, error: 'كلمة المرور الحالية غير صحيحة', success: null, active: 'settings' });
    }
    if (!new_password || new_password.length < 8) {
      return res.render('settings', { user, employees, pharmacySettings, error: 'كلمة المرور الجديدة لازم تكون 8 حروف على الأقل', success: null, active: 'settings' });
    }
    if (new_password !== confirm_password) {
      return res.render('settings', { user, employees, pharmacySettings, error: 'كلمة المرور الجديدة وتأكيدها مش متطابقين', success: null, active: 'settings' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    res.render('settings', { user, employees, pharmacySettings, error: null, success: 'تم تغيير كلمة المرور بنجاح', active: 'settings' });
  } catch (err) {
    next(err);
  }
});

router.post('/employees/add', async (req, res, next) => {
  try {
    const { username, full_name, password, role } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const employees = await getEmployees();
    const pharmacySettings = await getPharmacySettings();

    if (!username || !password || password.length < 6) {
      return res.render('settings', { user, employees, pharmacySettings, error: 'اكتب اسم مستخدم وكلمة مرور 6 حروف على الأقل', success: null, active: 'settings' });
    }
    const finalRole = ['pharmacist', 'cashier'].includes(role) ? role : 'cashier';

    const existing = await queryOne('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (existing) {
      return res.render('settings', { user, employees, pharmacySettings, error: 'اسم المستخدم ده مستخدم قبل كده', success: null, active: 'settings' });
    }

    const hash = bcrypt.hashSync(password, 10);
    await query(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)`,
      [username.trim(), hash, full_name || username.trim(), finalRole]
    );
    await logActivity(req, { action: 'إضافة موظف', entityType: 'user', details: { username: username.trim(), role: finalRole } });
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
    const pharmacySettings = await getPharmacySettings();

    if (!new_password || new_password.length < 6) {
      return res.render('settings', { user, employees, pharmacySettings, error: 'كلمة مرور الموظف الجديدة لازم تكون 6 حروف على الأقل', success: null, active: 'settings' });
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
