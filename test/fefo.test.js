// اختبارات البيع: FEFO، استبعاد المنتهي، الكمية الأكبر من المتاح، التزامن، وحدات البيع، ومنع الخصم المزدوج
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('FEFO / البيع', { skip: T.SKIP }, () => {
  let db; let shift;
  before(async () => { db = await T.createTestDb('fefo'); shift = await T.openShift(db, T.CASHIER); });
  after(async () => { if (db) await db.drop(); });

  it('تشغيلة منتهية + تشغيلة صالحة: البيع من الصالحة فقط', async () => {
    const m = await T.addMedicine(db);
    const expired = await T.addBatch(db, m, -5, 50);
    const valid = await T.addBatch(db, m, 100, 20);
    await T.sell(db, { shift, items: [{ med: m, qty: 8, price: 10 }] });
    assert.equal(await T.batchQty(db, expired), 50, 'المنتهية متتلمسش');
    assert.equal(await T.batchQty(db, valid), 12);
    await T.assertStockMatches(assert, db, m);
  });

  it('طلب أكبر من الصالح (والباقي منتهي) يترفض ومفيش أي تغيير', async () => {
    const m = await T.addMedicine(db);
    const expired = await T.addBatch(db, m, -1, 100);
    const valid = await T.addBatch(db, m, 30, 10);
    const e = await T.rejectsWith(assert, T.sell(db, { shift, items: [{ med: m, qty: 11, price: 10 }] }), 'PH001', 'الكمية الصالحة');
    assert.match(e.message, /المتاح الصالح: 10/);
    assert.equal(await T.batchQty(db, expired), 100);
    assert.equal(await T.batchQty(db, valid), 10);
    assert.equal((await db.q1(`SELECT COUNT(*)::int AS c FROM sale_invoices WHERE id IN (SELECT invoice_id FROM sale_items WHERE medicine_id = $1)`, [m])).c, 0, 'الفاتورة اتلغت بالـ rollback');
  });

  it('لا يوجد مخزون صالح (كله منتهي) يترفض', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, -10, 40);
    await T.rejectsWith(assert, T.sell(db, { shift, items: [{ med: m, qty: 1, price: 10 }] }), 'PH001', 'المتاح الصالح: 0');
  });

  it('صنف بدون أي تشغيلة يترفض', async () => {
    const m = await T.addMedicine(db);
    await T.rejectsWith(assert, T.sell(db, { shift, items: [{ med: m, qty: 1, price: 10 }] }), 'PH001');
  });

  it('عدة تشغيلات بتواريخ مختلفة: الأقرب صلاحية أولًا، وتسجيل التشغيلة لكل بند', async () => {
    const m = await T.addMedicine(db, { cost: 0 });
    const far = await T.addBatch(db, m, 300, 30, 9);
    const near = await T.addBatch(db, m, 20, 10, 3);
    const mid = await T.addBatch(db, m, 100, 15, 6);
    const inv = await T.sell(db, { shift, items: [{ med: m, qty: 30, price: 10 }] });
    assert.equal(await T.batchQty(db, near), 0);
    assert.equal(await T.batchQty(db, mid), 0);
    assert.equal(await T.batchQty(db, far), 25);
    const parts = await db.q(`SELECT sib.batch_id, sib.quantity_units FROM sale_item_batches sib
                              JOIN sale_items si ON si.id = sib.sale_item_id WHERE si.invoice_id = $1 ORDER BY sib.id`, [inv.id]);
    assert.deepEqual(parts.map((p) => [p.batch_id, p.quantity_units]), [[near, 10], [mid, 15], [far, 5]]);
    // التكلفة المرجّحة: (10*3 + 15*6 + 5*9)/30 = 5.5
    const item = await db.q1('SELECT cost_price_unit_snapshot FROM sale_items WHERE invoice_id = $1', [inv.id]);
    assert.equal(Number(item.cost_price_unit_snapshot), 5.5);
    const mv = await db.q1(`SELECT SUM(quantity_units)::int AS s FROM stock_movements WHERE medicine_id = $1 AND movement_type = 'sale'`, [m]);
    assert.equal(mv.s, -30);
    await T.assertStockMatches(assert, db, m);
  });

  it('وحدات البيع حبة/شريط/علبة تتحول صح، ومفيش خصم مزدوج للمخزون', async () => {
    // الشريط = 10 حبات، العلبة = 3 شرايط = 30 حبة
    const m = await T.addMedicine(db, { ups: 10, spb: 3, price: 1, priceStrip: 9, priceBox: 25 });
    const b = await T.addBatch(db, m, 200, 100);
    assert.equal(await T.stock(db, m), 100);
    const inv = await T.sell(db, { shift, items: [
      { med: m, qty: 1, unit: 'box', price: 25 },
      { med: m, qty: 2, unit: 'strip', price: 9 },
      { med: m, qty: 5, unit: 'unit', price: 1 }
    ] });
    assert.equal(inv.total, 25 + 18 + 5);
    assert.equal(await T.batchQty(db, b), 100 - 30 - 20 - 5);
    assert.equal(await T.stock(db, m), 45, 'الخصم مرة واحدة بس (مش من الـ trigger القديم + الجديد)');
    const rows = await db.q(`SELECT sale_unit, quantity_units FROM sale_items WHERE invoice_id = $1 ORDER BY id`, [inv.id]);
    assert.deepEqual(rows.map((r) => [r.sale_unit, r.quantity_units]), [['box', 30], ['strip', 20], ['unit', 5]]);
    const sib = await db.q1(`SELECT SUM(sib.quantity_units)::int AS s FROM sale_item_batches sib JOIN sale_items si ON si.id = sib.sale_item_id WHERE si.invoice_id = $1`, [inv.id]);
    assert.equal(sib.s, 55);
    await T.assertStockMatches(assert, db, m);
  });

  it('نفس الصنف في بندين بنفس الفاتورة: الخصم تراكمي وبيرفض لو تعدّى المتاح', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    await T.rejectsWith(assert, T.sell(db, { shift, items: [{ med: m, qty: 6, price: 10 }, { med: m, qty: 6, price: 10 }] }), 'PH001');
    assert.equal(await T.stock(db, m), 10);
  });

  it('تعديل stock_units مباشرة مرفوض (مصدر الحقيقة = التشغيلات)', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    await T.rejectsWith(assert, db.q('UPDATE medicines SET stock_units = 999 WHERE id = $1', [m]), 'PH001', 'تعديل المخزون مباشرة');
    assert.equal(await T.stock(db, m), 10);
  });

  it('التزامن: آخر وحدة في المخزون وجلستين psql متوازيتين — واحدة بس تنجح', async () => {
    const m = await T.addMedicine(db, { name: 'concurrent-med' });
    const b = await T.addBatch(db, m, 60, 1);
    const script = (delaySql) => `
      ${delaySql}
      DO $$
      DECLARE i INTEGER;
      BEGIN
        INSERT INTO sale_invoices (discount, payment_method, created_by, shift_id) VALUES (0, 'cash', ${T.CASHIER}, ${shift}) RETURNING id INTO i;
        INSERT INTO sale_items (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, unit_price, total)
          VALUES (i, ${m}, 'concurrent-med', 'unit', 1, 0, 10, 10);
        PERFORM pg_sleep(1.5);              -- نخلّي الجلسة الأولى ماسكة القفل وقت دخول التانية
        PERFORM finalize_sale_invoice(i, 0, ${T.CASHIER});
      END $$;`;
    const [r1, r2] = await Promise.all([
      T.psql(db.url, script('')),
      T.psql(db.url, script('SELECT pg_sleep(0.4);'))
    ]);
    assert.equal([r1, r2].filter((r) => r.code === 0).length, 1, `واحدة بس لازم تنجح: ${JSON.stringify([r1, r2])}`);
    const failed = [r1, r2].find((r) => r.code !== 0);
    assert.match(failed.stderr, /الكمية الصالحة/);
    assert.equal(await T.batchQty(db, b), 0);
    assert.equal(await T.stock(db, m), 0);
    const n = await db.q1(`SELECT COUNT(*)::int AS c FROM sale_items WHERE medicine_id = $1`, [m]);
    assert.equal(n.c, 1);
  });
});
