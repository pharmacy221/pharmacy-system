// اختبارات المرتجعات (create_return)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('المرتجعات', { skip: T.SKIP }, () => {
  let db; let cashierShift; let adminShift;
  const ret = (itemId, qty, restock = true, method = null, key = null, user = T.ADMIN) =>
    db.q1('SELECT create_return($1,$2,$3,$4,$5,$6,$7,$8) AS r', [itemId, qty, 'سبب', restock, method, user, 'u', key]).then((r) => r.r);
  const firstItem = (invId) => db.q1('SELECT id FROM sale_items WHERE invoice_id = $1 ORDER BY id LIMIT 1', [invId]).then((r) => r.id);
  const cashSum = (invId) => db.q1(`SELECT COALESCE(SUM(amount),0)::numeric AS s FROM cash_movements WHERE invoice_id = $1`, [invId]).then((r) => Number(r.s));

  before(async () => {
    db = await T.createTestDb('returns');
    cashierShift = await T.openShift(db, T.CASHIER);
    adminShift = await T.openShift(db, T.ADMIN);
  });
  after(async () => { if (db) await db.drop(); });

  it('مرتجع كامل: المخزون يرجع على نفس التشغيلة والمبلغ كامل والخزنة تتطابق', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 40, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 10, price: 10 }] });
    const r = await ret(await firstItem(inv.id), 10);
    assert.equal(r.refund_amount, 100);
    assert.equal(r.restocked_units, 10);
    assert.equal(await T.batchQty(db, b), 10);
    await T.assertStockMatches(assert, db, m);
    assert.equal(await cashSum(inv.id), 0, 'المبيعات 100 − المرتجع 100 = 0 في الخزنة');
    const row = await db.q1(`SELECT shift_id, amount FROM cash_movements WHERE movement_type = 'refund' AND invoice_id = $1`, [inv.id]);
    assert.equal(row.shift_id, adminShift);
    assert.equal(Number(row.amount), -100);
  });

  it('مرتجع جزئي ثم مرتجع تاني على نفس البند، وتجاوز الكمية مرفوض', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 40, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 10, price: 10 }] });
    const item = await firstItem(inv.id);
    assert.equal((await ret(item, 3)).refund_amount, 30);
    assert.equal((await ret(item, 4)).refund_amount, 40);
    await T.rejectsWith(assert, ret(item, 4), 'PH001', 'المتبقي: 3');
    assert.equal((await ret(item, 3)).refund_amount, 30);
    await T.rejectsWith(assert, ret(item, 1), 'PH001', 'المتبقي: 0');
    assert.equal(await T.batchQty(db, b), 10);
    await T.assertStockMatches(assert, db, m);
    assert.equal((await db.q1('SELECT COALESCE(SUM(refund_amount),0)::numeric AS s FROM returns WHERE sale_item_id = $1', [item])).s * 1, 100);
  });

  it('كمية صفر/سالبة مرفوضة', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 40, 5);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 5, price: 10 }] });
    const item = await firstItem(inv.id);
    await T.rejectsWith(assert, ret(item, 0), 'PH001');
    await T.rejectsWith(assert, ret(item, -2), 'PH001');
  });

  it('مرتجع تالف: المبلغ يترد لكن المخزون ميزيدش', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 40, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 4, price: 10 }] });
    const r = await ret(await firstItem(inv.id), 4, false);
    assert.equal(r.refund_amount, 40);
    assert.equal(r.restocked_units, 0);
    assert.equal(await T.batchQty(db, b), 6);
    await T.assertStockMatches(assert, db, m);
    const rr = await db.q1('SELECT restocked, restocked_units, cost_recovered FROM returns WHERE id = $1', [r.return_id]);
    assert.deepEqual([rr.restocked, rr.restocked_units, Number(rr.cost_recovered)], [false, 0, 0]);
  });

  it('فاتورة بخصم: المبلغ المسترد بعد نصيب الخصم، والآخر ياخد الباقي بالظبط', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 40, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 2, price: 50 }], discount: 20 });  // 100 − 20 = 80
    assert.equal(inv.total, 80);
    const item = await firstItem(inv.id);
    assert.equal((await ret(item, 1)).refund_amount, 40);
    assert.equal((await ret(item, 1)).refund_amount, 40);
    assert.equal(await cashSum(inv.id), 0);
  });

  it('فاتورة بخصم على 3 أصناف: مجموع المرتجعات الكاملة = إجمالي الفاتورة بالظبط (بدون كسور ضايعة)', async () => {
    const ms = [];
    for (let i = 0; i < 3; i++) { const m = await T.addMedicine(db); await T.addBatch(db, m, 40, 10); ms.push(m); }
    const inv = await T.sell(db, { shift: cashierShift, items: [
      { med: ms[0], qty: 1, price: 33.33 }, { med: ms[1], qty: 1, price: 33.33 }, { med: ms[2], qty: 1, price: 33.34 }
    ], discount: 10 });
    assert.equal(inv.total, 90);
    let sum = 0;
    for (const it of await db.q('SELECT id FROM sale_items WHERE invoice_id = $1 ORDER BY id', [inv.id])) sum += (await ret(it.id, 1)).refund_amount;
    assert.equal(Math.round(sum * 100) / 100, 90);
  });

  it('تكرار نفس الطلب بنفس مفتاح الـ idempotency: مرتجع واحد فقط', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 40, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 10, price: 10 }] });
    const item = await firstItem(inv.id);
    const a = await ret(item, 2, true, null, 'key-abcdef-1');
    const c = await ret(item, 2, true, null, 'key-abcdef-1');
    assert.equal(a.duplicate, false);
    assert.equal(c.duplicate, true);
    assert.equal(c.return_id, a.return_id);
    assert.equal(await T.batchQty(db, b), 2 + 0);          // 10 − 10 + 2 = 2
    assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM returns WHERE sale_item_id = $1', [item])).c, 1);
    await T.assertStockMatches(assert, db, m);
  });

  it('مرتجع على تشغيلة منتهية: المبلغ يترد والمخزون الصالح ميزيدش', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 3, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 5, price: 10 }] });
    await T.expireBatch(db, b, 1);
    const r = await ret(await firstItem(inv.id), 5, true);
    assert.equal(r.refund_amount, 50);
    assert.equal(r.restocked_units, 0);
    assert.equal(await T.batchQty(db, b), 5);
    await T.assertStockMatches(assert, db, m);
  });

  it('مرتجع بيع متعدد التشغيلات يرجّع كل جزء لتشغيلته', async () => {
    const m = await T.addMedicine(db);
    const b1 = await T.addBatch(db, m, 10, 4);
    const b2 = await T.addBatch(db, m, 80, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 7, price: 10 }] });   // 4 من b1 + 3 من b2
    assert.equal(await T.batchQty(db, b1), 0);
    await ret(await firstItem(inv.id), 7);
    assert.equal(await T.batchQty(db, b1), 4);
    assert.equal(await T.batchQty(db, b2), 10);
    await T.assertStockMatches(assert, db, m);
  });

  it('رد نقدي بدون وردية مفتوحة مرفوض، لكن none (استبدال) مسموح ولا يمس الخزنة', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 40, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 4, price: 10 }] });
    const item = await firstItem(inv.id);
    await T.rejectsWith(assert, ret(item, 1, true, 'cash', null, T.PHARMA), 'PH001', 'وردية');
    assert.equal(await T.stock(db, m), 6, 'المرفوض متسجلش حاجة');
    const r = await ret(item, 1, true, 'none', null, T.PHARMA);
    assert.equal(r.restocked_units, 1);
    assert.equal(await cashSum(inv.id), 40, 'مفيش حركة خزنة للـ none');
  });

  it('مرتجع على بند غير موجود مرفوض (404)', async () => {
    await T.rejectsWith(assert, ret(987654, 1), 'PH002');
  });
});
