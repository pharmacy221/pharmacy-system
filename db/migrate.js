// db/migrate.js  (اختياري)
// بيطبّق ملفات الـ migration بالترتيب مرة واحدة لكل ملف (بيسجل في جدول schema_migrations).
// الملفات نفسها idempotent، فتشغيله تاني آمن. مبيشغّلش pharmacy_schema.sql ولا migration_forms.sql.
//   node db/migrate.js            # يطبّق اللي ناقص
//   node db/migrate.js --status   # يعرض الحالة فقط
// خد نسخة احتياطية (pg_dump) قبل أول تشغيل على بيانات حقيقية.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

const FILES = ['migration_002_integrity_fixes.sql', 'migration_003_pharmacy_date_views.sql', 'migration_004_purchases.sql', 'migration_005_customers_credit_compliance.sql', 'migration_006_price_history.sql', 'migration_007_no_credit_limit.sql', 'migration_008_order_discount_supplier_company.sql', 'migration_009_item_discount.sql'];

async function main() {
  const statusOnly = process.argv.includes('--status');
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of FILES) {
    if (done.has(f)) { console.log(`✓ ${f} (متطبق)`); continue; }
    if (statusOnly) { console.log(`• ${f} (لسه)`); continue; }
    const sql = fs.readFileSync(path.join(__dirname, f), 'utf8'); // الملف فيه BEGIN/COMMIT بتاعه
    console.log(`→ تطبيق ${f} ...`);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    console.log(`✓ ${f}`);
  }
}

main()
  .catch((err) => { console.error('❌ فشل الـ migration:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
