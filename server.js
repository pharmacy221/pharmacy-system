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

const { requireLogin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ضروري جداً لـ Vercel ---
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.use((req, res) => {
  res.status(404).send('الصفحة غير موجودة');
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 السيرفر شغال على http://localhost:${PORT}`);
  });
}

module.exports = app;
