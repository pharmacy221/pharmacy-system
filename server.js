require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');

const authRoutes = require('./routes/auth');
const homeRoutes = require('./routes/home');
const dashboardRoutes = require('./routes/dashboard');
const productsRoutes = require('./routes/products');
const salesRoutes = require('./routes/sales');
const returnsRoutes = require('./routes/returns');
const posRoutes = require('./routes/pos');
const settingsRoutes = require('./routes/settings');
const reportsRoutes = require('./routes/reports');
const activityLogRoutes = require('./routes/activity-log');
const shiftsRouter = require('./routes/shifts');
const suppliersRouter = require('./routes/suppliers');
const couponsRouter = require('./routes/coupons');
const symptomSearchRoutes = require('./routes/symptom-search');
const drugLookupRoutes = require('./routes/drug-lookup');
const payrollRoutes = require('./routes/payroll');
const expensesRoutes = require('./routes/expenses');
const purchasesRoutes = require('./routes/purchases');


const { requireLogin } = require('./middleware/auth');
const { getShortcuts, NAV_HREFS } = require('./lib/shortcuts');

const app = express();
const PORT = process.env.PORT || 3000;

// في الإنتاج لازم يكون فيه SESSION_SECRET حقيقي (غير كده أي حد يقدر يزوّر الجلسة)
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('❌ لازم تحط SESSION_SECRET في متغيرات البيئة قبل التشغيل في الإنتاج');
  process.exit(1);
}

// --- ضروري جداً لـ Vercel ---
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// هيدرز أمان أساسية + منع تخزين الصفحات الديناميكية (عشان زر الرجوع ميعرضش صفحات بعد تسجيل الخروج)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  });
  next();
});

app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-env-file',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // أسبوع
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// متاح لكل الـ views
app.use((req, res, next) => {
  res.locals.username = req.session.username || null;
  res.locals.role = req.session.role || null;
  res.locals.shopName = process.env.PHARMACY_NAME || 'السوركي ';
  next();
});

// اختصارات الكيبورد اللي حددها الأدمن (متاحة لكل الصفحات بعد تسجيل الدخول)
app.use(async (req, res, next) => {
  res.locals.scConfig = { keys: {}, nav: NAV_HREFS };
  if (req.session && req.session.userId) {
    try { res.locals.scConfig.keys = await getShortcuts(); } catch (err) { /* بنكمل بدون اختصارات */ }
  }
  next();
});

app.use('/', authRoutes);
app.use('/', requireLogin, homeRoutes);
app.use('/dashboard', requireLogin, dashboardRoutes);
app.use('/products', productsRoutes);
app.use('/sales', salesRoutes);
app.use('/returns', returnsRoutes);
app.use('/pos', posRoutes);
app.use('/settings', settingsRoutes);
app.use('/reports', reportsRoutes);
app.use('/activity-log', activityLogRoutes);
app.use('/shifts', shiftsRouter);
app.use('/suppliers', suppliersRouter);
app.use('/coupons', couponsRouter);
app.use('/symptom-search', symptomSearchRoutes);
app.use('/drug-lookup', drugLookupRoutes);
app.use('/payroll', payrollRoutes);
app.use('/expenses', expensesRoutes);
app.use('/purchases', purchasesRoutes);

app.use((req, res) => {
  res.status(404).render('error', { code: 404, message: 'الصفحة غير موجودة' });
});

// معالج أخطاء موحّد: بدل ما السيرفر يرجّع صفحة خطأ خام
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('❌ خطأ في الطلب', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(500).json({ error: 'حصل خطأ في السيرفر، حاول تاني' });
  res.status(500).render('error', { code: 500, message: 'حصل خطأ غير متوقع، حاول تاني' });
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 السيرفر شغال على http://localhost:${PORT}`);
  });
}

module.exports = app;
