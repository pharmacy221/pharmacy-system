// db/index.js
// الاتصال بقاعدة بيانات Supabase (Postgres) بدل node:sqlite
require('dotenv').config();
const { Pool, types } = require('pg');

// افتراضيًا pg بترجع أعمدة NUMERIC/DECIMAL كـ string عشان متفقدش دقة الأرقام الكبيرة جدًا.
// المشروع ده مش محتاج الدقة الفائقة دي، وكل الـ views (dashboard, products, sales, transactions)
// مبنية على إن القيمة رقم عادي فيه .toFixed(2)، زي ما كانت شغالة مع SQLite بالظبط.
// فبنحول النوع OID 1700 (NUMERIC) لرقم JS مباشرة هنا في مكان واحد بدل ما نعدل كل view.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

if (!process.env.DATABASE_URL) {
  console.error('❌ لازم تحط DATABASE_URL في ملف .env (Connection String بتاع Supabase)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase محتاج SSL؛ الإعداد ده شغال مع أي شهادة عادية من غير ما نحتاج ملف CA خاص
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('❌ خطأ غير متوقع في اتصال قاعدة البيانات:', err);
});

// دالة مساعدة بسيطة للاستعلامات العادية (بترجع rows مباشرة)
async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

// بترجع صف واحد بس (أو null لو مفيش نتيجة) - بديل لـ .get() في better-sqlite3
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// لو محتاج تعمل أكتر من عملية جوه transaction واحدة (زي تسجيل بيع)
// بيرجع "client" لازم تقفله بـ client.release() بعد ما تخلص
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, queryOne, getClient };