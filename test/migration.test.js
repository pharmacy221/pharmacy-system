// اختبارات الـ migration: إعادة التشغيل، عدم تعديل البيانات القديمة، مسار البيانات القديمة، والـ rollback
const fs = require('fs');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

const sql = (f) => fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8');

describe('migration', { skip: T.SKIP }, () => {
  let db; let shift;
  before(async () => { db = await T.createTestDb('migration'); shift = await T.openShift(db, T.CASHIER); });
  after(async () => { if (db) await db.drop(); });

  it('إعادة تشغيل 002 و003 أكتر من مرة بدون أخطاء ولا تغيير في بيانات المخزون', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    const before = await db.q('SELECT id, stock_units FROM medicines ORDER BY id');
    await db.pool.query(sql('migration_002_integrity_fixes.sql'));
    await db.pool.query(sql('migration_002_integrity_fixes.sql'));
    await db.pool.query(sql('migration_003_pharmacy_date_views.sql'));
    assert.deepEqual(await db.q('SELECT id, stock_units FROM medicines ORDER BY id'), before);
  });

  it('فروق المخزون القديمة (من غير تشغيلات) بتظهر في الـ view ومبتتصلحش تلقائيًا حتى بعد إعادة الـ migration', async () => {
    // بيانات "قديمة": رصيد على الصنف من غير تشغيلة (الإدراج المباشر مسموح؛ التعديل بعد كده بس هو المرفوض)
    const legacy = (await db.q1(`INSERT INTO medicines (name, sale_price_unit, stock_units) VALUES ('legacy', 5, 30) RETURNING id`)).id;
    await db.pool.query(sql('migration_002_integrity_fixes.sql'));
    const rows = await db.q('SELECT * FROM v_stock_batch_mismatch WHERE medicine_id = $1', [legacy]);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].stock_units, Number(rows[0].batches_units), Number(rows[0].difference)], [30, 0, 30]);
    assert.equal(await T.stock(db, legacy), 30);
    // البيع من رصيد غير مسجل في تشغيلات مرفوض (مفيش تشغيلة صالحة)
    await T.rejectsWith(assert, T.sell(db, { shift, items: [{ med: legacy, qty: 1, price: 5 }] }), 'PH001');
    // نقص بالتسوية من الرصيد غير المسجل مسموح ومتسجل
    await db.q1(`SELECT adjust_medicine_stock($1, 20, 'جرد', $2, 'admin')`, [legacy, T.ADMIN]);
    assert.equal(await T.stock(db, legacy), 20);
    // الزيادة بدون تشغيلة صالحة مرفوضة
    await T.rejectsWith(assert, db.q(`SELECT adjust_medicine_stock($1, 50, 'جرد', $2, 'admin')`, [legacy, T.ADMIN]), 'PH001', 'تشغيلة صالحة');
  });

  it('فاتورة قديمة (من غير تسجيل تشغيلات) بتتلغى بالسلوك القديم: ترجع على أحدث تشغيلة صالحة', async () => {
    const m = await T.addMedicine(db, { name: 'oldinv' });
    const b1 = await T.addBatch(db, m, 20, 10);
    const b2 = await T.addBatch(db, m, 200, 10);
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE sale_items DISABLE TRIGGER trg_deduct_stock_fefo');   // محاكاة بند اتسجل قبل التحديث
      const inv = (await c.query(`INSERT INTO sale_invoices (total, payment_method, created_by, shift_id) VALUES (30, 'cash', $1, $2) RETURNING id`, [T.CASHIER, shift])).rows[0].id;
      await c.query(`INSERT INTO sale_items (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, unit_price, total)
                     VALUES ($1, $2, 'oldinv', 'unit', 3, 0, 10, 30)`, [inv, m]);
      await c.query(`UPDATE batches SET quantity_units = quantity_units - 3 WHERE id = $1`, [b1]);   // الخصم القديم
      await c.query('ALTER TABLE sale_items ENABLE TRIGGER trg_deduct_stock_fefo');
      await c.query('COMMIT');
      const adminShift = await T.openShift(db, T.ADMIN);
      assert.ok(adminShift);
      const r = (await db.q1(`SELECT void_sale_invoice($1, $2, 'admin', 'قديمة', NULL) AS r`, [inv, T.ADMIN])).r;
      assert.equal(r.restored_units, 3);
      assert.equal(await T.batchQty(db, b2), 13, 'رجعت على أحدث تشغيلة صالحة (سلوك قديم)');
      await T.assertStockMatches(assert, db, m);
    } finally { c.release(); }
  });

  it('الـ rollback: يرجّع السلوك القديم (بيع بدون قيود جديدة) ويمكن إعادة تطبيق 002 بعده', async () => {
    const m = await T.addMedicine(db, { name: 'rb' });
    await T.addBatch(db, m, 50, 10);
    await db.pool.query(sql('migration_002_rollback.sql'));
    await db.pool.query(sql('migration_002_rollback.sql'));      // idempotent
    // السلوك القديم: stock_units تتعدل مباشرة، والفاتورة تتحذف
    await db.q('UPDATE medicines SET stock_units = 77 WHERE id = $1', [m]);
    assert.equal(await T.stock(db, m), 77);
    await db.q('UPDATE medicines SET stock_units = 10 WHERE id = $1', [m]);
    const c = await db.pool.connect();
    try {
      const inv = (await c.query(`INSERT INTO sale_invoices (payment_method, created_by) VALUES ('cash', $1) RETURNING id`, [T.CASHIER])).rows[0].id;
      await c.query(`INSERT INTO sale_items (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, unit_price, total)
                     VALUES ($1, $2, 'rb', 'unit', 4, 0, 10, 40)`, [inv, m]);
      assert.equal(await T.stock(db, m), 6, 'الـ trigger القديم بيخصم');
      assert.equal(await T.batchQty(db, (await db.q1('SELECT id FROM batches WHERE medicine_id = $1', [m])).id), 6);
      await c.query('DELETE FROM sale_invoices WHERE id = $1', [inv]);                 // مسموح في السلوك القديم
    } finally { c.release(); }
    // البيانات الجديدة محفوظة (مفيش جداول اتحذفت)
    assert.ok(await db.q1(`SELECT to_regclass('stock_movements') AS t`).then((r) => r.t));
    // إعادة التطبيق
    await db.pool.query(sql('migration_002_integrity_fixes.sql'));
    await db.pool.query(sql('migration_003_pharmacy_date_views.sql'));
    await T.rejectsWith(assert, db.q('UPDATE medicines SET stock_units = 1 WHERE id = $1', [m]), 'PH001');
  });
});
