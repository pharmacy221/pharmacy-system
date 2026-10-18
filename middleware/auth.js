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

// صلاحية على مستوى السيرفر لعمليات حساسة (مرتجعات، استلام تشغيلات...): بيسمح بالأدوار المحددة بس.
// الرفض بيرجع 403 صريح (مش redirect) عشان العملية متتنفذش ومحدش يفتكر إنها نجحت.
function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.redirect('/login');
    }
    if (roles.includes(req.session.role)) {
      return next();
    }
    const wantsJson = req.xhr || ((req.headers && req.headers.accept) || '').includes('application/json');
    if (wantsJson) return res.status(403).json({ error: 'غير مصرح لك بتنفيذ هذه العملية' });
    return res.status(403).send('غير مصرح لك بتنفيذ هذه العملية');
  };
}

module.exports = { requireLogin, requireAdmin, requireRole };
