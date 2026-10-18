// test/helpers/db.js
// أدوات اختبار مشتركة: بتنشئ قاعدة بيانات اختبار منفصلة لكل ملف اختبار (ما بتلمسش أي قاعدة تانية)،
// وبتطبّق: pharmacy_schema.sql → migration_forms.sql → migration_002 → migration_003.
//
// التشغيل:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm test
// (المستخدم لازم يقدر يعمل CREATE DATABASE / DROP DATABASE). لو المتغير مش موجود الاختبارات بتتخطى.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client, Pool } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || '';
const SKIP = ADMIN_URL ? false : 'TEST_DATABASE_URL غير محدد — اختبارات قاعدة البيانات اتخطّت';
const DB_DIR = path.join(__dirname, '..', '..', 'db');
const FILES = ['pharmacy_schema.sql', 'migration_forms.sql', 'migration_002_integrity_fixes.sql', 'migration_003_pharmacy_date_views.sql'];

function withDb(url, dbname) {
  const u = new URL(url);
  u.pathname = '/' + dbname;
  return u.toString();
}

async function createTestDb(label) {
  const name = `ph_test_${label}_${process.pid}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = withDb(ADMIN_URL, name);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  for (const f of FILES) await setup.query(fs.readFileSync(path.join(DB_DIR, f), 'utf8'));
  // جدول الحضور (مش موجود في ملفات الـ SQL بتاعت المشروع؛ بيتعمل في Supabase يدويًا) — شكل مبسّط للاختبار
  await setup.query(`CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL, attendance_date DATE NOT NULL, status TEXT,
    check_in TEXT, check_out TEXT, notes TEXT, UNIQUE (employee_id, attendance_date))`);
  await setup.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id INTEGER`);
  await setup.query(`INSERT INTO users (id, username, password_hash, full_name, role) VALUES
    (1,'admin','x','Admin','admin'), (2,'pharma','x','Pharmacist','pharmacist'), (3,'cashier','x','Cashier','cashier'), (4,'cashier2','x','Cashier2','cashier')`);
  await setup.query(`SELECT setval(pg_get_serial_sequence('users','id'), 4)`);
  await setup.end();

  const pool = new Pool({ connectionString: url });
  pool.on('error', () => {});
  return {
    url, name, pool,
    q: (text, params) => pool.query(text, params).then((r) => r.rows),
    q1: (text, params) => pool.query(text, params).then((r) => r.rows[0] || null),
    async drop() {
      await pool.end();
      const a = new Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    }
  };
}

// تشغيل SQL عبر psql حقيقي (جلسة مستقلة). بيرجّع { code, stdout, stderr }.
function psql(url, sql) {
  return new Promise((resolve) => {
    const p = spawn('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', url], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.stdin.end(sql);
  });
}

// ---------------- بيانات اختبار ----------------
const ADMIN = 1;
const PHARMA = 2;
const CASHIER = 3;

async function addMedicine(db, o = {}) {
  const r = await db.q1(
    `INSERT INTO medicines (name, units_per_strip, strips_per_box, sale_price_unit, sale_price_strip, sale_price_box, cost_price_unit, stock_units)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id`,
    [o.name || `med-${Math.random().toString(36).slice(2, 8)}`, o.ups || 1, o.spb || 1, o.price ?? 10,
     o.priceStrip ?? null, o.priceBox ?? null, o.cost ?? 0]
  );
  return r.id;
}

// daysFromToday: موجب = لسه صالحة، سالب = منتهية
async function addBatch(db, medId, daysFromToday, qty, cost = 5, num = null) {
  const r = await db.q1(
    `INSERT INTO batches (medicine_id, batch_number, expiry_date, received_units, quantity_units, cost_price_unit)
     VALUES ($1, $2, pharmacy_today() + $3::int, $4, $4, $5) RETURNING id`,
    [medId, num, daysFromToday, qty, cost]
  );
  return r.id;
}

// بتسجل منتهية بالتحايل: التشغيلة بتتضاف صالحة وبعدين صلاحيتها بتتعدل لتاريخ ماضي (زي تشغيلة عدّى عليها الوقت)
async function expireBatch(db, batchId, daysAgo = 1) {
  await db.q(`UPDATE batches SET expiry_date = pharmacy_today() - $2::int WHERE id = $1`, [batchId, daysAgo]);
}

async function openShift(db, userId, opening = 0) {
  const r = await db.q1(`INSERT INTO shifts (opened_by, opening_balance) VALUES ($1, $2) RETURNING id`, [userId, opening]);
  return r.id;
}

// بيع مباشر عبر SQL (نفس خطوات routes/pos.js): رأس + بنود + finalize_sale_invoice.
// items: [{ med, qty, unit='unit', price }]  price = سعر الوحدة المختارة
async function sell(db, { user = CASHIER, shift, items, discount = 0, method = 'cash' }) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const inv = (await c.query(
      `INSERT INTO sale_invoices (discount, payment_method, created_by, shift_id) VALUES (0, $1, $2, $3) RETURNING id`,
      [method, user, shift]
    )).rows[0].id;
    for (const it of items) {
      const unit = it.unit || 'unit';
      const total = Math.round(it.price * it.qty * 100) / 100;
      await c.query(
        `INSERT INTO sale_items (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, unit_price, total)
         VALUES ($1, $2, (SELECT name FROM medicines WHERE id = $2), $3, $4, 0, $5, $6)`,
        [inv, it.med, unit, it.qty, it.price, total]
      );
    }
    const t = (await c.query('SELECT finalize_sale_invoice($1, $2, $3) AS total', [inv, discount, user])).rows[0].total;
    await c.query('COMMIT');
    return { id: inv, total: Number(t) };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (x) { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

const stock = async (db, medId) => (await db.q1('SELECT stock_units FROM medicines WHERE id = $1', [medId])).stock_units;
const batchesSum = async (db, medId) => Number((await db.q1('SELECT COALESCE(SUM(quantity_units),0) AS s FROM batches WHERE medicine_id = $1', [medId])).s);
const batchQty = async (db, id) => (await db.q1('SELECT quantity_units FROM batches WHERE id = $1', [id])).quantity_units;

// يتأكد إن إجمالي الصنف = مجموع تشغيلاته
async function assertStockMatches(assert, db, medId) {
  assert.equal(await stock(db, medId), await batchesSum(db, medId), 'stock_units لازم تساوي مجموع التشغيلات');
}

// يتوقع إن الوعد يترفض بخطأ كود SQLSTATE معين (واختياريًا جزء من الرسالة)
async function rejectsWith(assert, promise, code, msgPart) {
  try {
    await promise;
  } catch (e) {
    if (code) assert.equal(e.code, code, `كود الخطأ المتوقع ${code} لكن اتجاب ${e.code}: ${e.message}`);
    if (msgPart) assert.ok(String(e.message).includes(msgPart), `الرسالة لازم تحتوي "${msgPart}": ${e.message}`);
    return e;
  }
  assert.fail('كان لازم العملية تترفض');
}

module.exports = {
  SKIP, createTestDb, psql, ADMIN, PHARMA, CASHIER,
  addMedicine, addBatch, expireBatch, openShift, sell, stock, batchesSum, batchQty, assertStockMatches, rejectsWith
};
