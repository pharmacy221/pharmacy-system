const express = require('express');
const bcrypt = require('bcryptjs');
const { queryOne } = require('../db');
const { logActivity } = require('../lib/activity-log');
const router = express.Router();
router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null });
});
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.render('login', { error: 'من فضلك أدخل اسم المستخدم وكلمة المرور' });
    }
    const user = await queryOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role || 'admin';
    req.session.save(async (err) => {
      if (err) {
        console.error('خطأ في حفظ الجلسة:', err);
        return res.render('login', { error: 'حصل خطأ غير متوقع، حاول تاني' });
      }
      await logActivity(req, {
        action: 'تسجيل دخول',
        entityType: 'user',
        entityId: user.id
      });
      res.redirect(req.session.role === 'admin' ? '/' : '/pos');
    });
  } catch (err) {
    next(err);
  }
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});
module.exports = router;
