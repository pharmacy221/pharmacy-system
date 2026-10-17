// middleware/auth.js

function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.redirect('/login');
}

// حماية الصفحات اللي مينفعش غير الأدمن يدخلها
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') {
    return next();
  }
  // مستخدم مسجل دخول لكنه مش أدمن (صيدلي أو كاشير) بيحاول يفتح صفحة الأدمن
  // بدل ما نورّيه رسالة مقفولة، نحوّله على شاشة نقطة البيع بتاعته
  if (req.session && req.session.userId) {
    return res.redirect('/pos');
  }
  return res.status(403).send('غير مصرح لك بالدخول لهذه الصفحة');
}

module.exports = { requireLogin, requireAdmin };
