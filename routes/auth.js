const express = require('express');
const bcrypt = require('bcryptjs');
const { queryOne } = require('../db');
const { logActivity } = require('../lib/activity-log');
const router = express.Router();

// حماية بسيطة من تخمين كلمة المرور: 8 محاولات فاشلة كل 15 دقيقة لكل (IP + اسم مستخدم)
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();
function failKey(req, username) { return `${req.ip}|${String(username || '').toLowerCase()}`; }
function isLocked(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { fails.delete(key); return false; }
  return f.count >= MAX_FAILS;
}
function addFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) fails.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
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
    const key = failKey(req, username);
    if (isLocked(key)) {
      return res.render('login', { error: 'محاولات كتير غلط، استنى شوية وحاول تاني' });
    }
    const user = await queryOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      addFail(key);
      return res.render('login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    fails.delete(key);
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
