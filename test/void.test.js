// اختبارات إلغاء الفاتورة (Void) بدل الحذف
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('إلغاء الفواتير', { skip: T.SKIP }, () => {
  let db; let cashierShift; let adminShift;
  const voidInv = (id, reason = 'غلط في الفاتورة', method = null, user = T.ADMIN) =>
    db.q1('SELECT void_sale_invoice($1, $2, $3, $4, $5) AS r', [id, user, 'admin', reason, method]).then((r) => r.r);
  const ret = (itemId, qty, restock = true, method = null, key = null) =>
    db.q1('SELECT create_return($1,$2,$3,$4,$5,$6,$7,$8) AS r', [itemId, qty, 'سبب', restock, method, T.ADMIN, 'admin', key]).then((r) => r.r);

  before(async () => {
    db = await T.createTestDb('void');
    cashierShift = await T.openShift(db, T.CASHIER);
    adminShift = await T.openShift(db, T.ADMIN);
  });
  after(async () => { if (db) await db.drop(); });

  it('إلغاء بدون مرتجع: المخزون يرجع للتشغيلة نفسها والخزنة تتعكس والفاتورة تفضل موجودة', async () => {
    const m = await T.addMedicine(db);
    const b1 = await T.addBatch(db, m, 20, 10);
    const b2 = await T.addBatch(db, m, 90, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 15, price: 10 }] });
    assert.equal(await T.batchQty(db, b1), 0);
    assert.equal(await T.batchQty(db, b2), 5);

    const r = await voidInv(inv.id);
    assert.equal(r.restored_units, 15);
    assert.equal(await T.batchQty(db, b1), 10, 'رجعت على نفس التشغيلة اللي اتباعت منها');
    assert.equal(await T.batchQty(db, b2), 10);
    await T.assertStockMatches(assert, db, m);

    const row = await db.q1('SELECT status, void_reason, voided_by FROM sale_invoices WHERE id = $1', [inv.id]);
    assert.deepEqual([row.status, row.void_reason, row.voided_by], ['voided', 'غلط في الفاتورة', T.ADMIN]);
    assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM sale_items WHERE invoice_id = $1', [inv.id])).c, 1, 'البنود محفوظة');
    const cm = await db.q1(`SELECT amount, shift_id, movement_type FROM cash_movements WHERE invoice_id = $1 AND movement_type = 'void_refund'`, [inv.id]);
    assert.equal(Number(cm.amount), -150);
    assert.equal(cm.shift_id, adminShift);
    const audit = await db.q1(`SELECT details FROM activity_log WHERE action = 'إلغاء فاتورة بيع' ORDER BY id DESC LIMIT 1`);
    assert.equal(JSON.parse(audit.details).entity_id, String(inv.id));
  });

  it('إلغاء مرتين مرفوض ولا يزوّد المخزون تاني', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 4, price: 10 }] });
    await voidInv(inv.id);
    const before = await T.stock(db, m);
    await T.rejectsWith(assert, voidInv(inv.id), 'PH003', 'ملغاة بالفعل');
    assert.equal(await T.stock(db, m), before);
    assert.equal(before, 10);
    assert.equal((await db.q1(`SELECT COUNT(*)::int AS c FROM cash_movements WHERE invoice_id = $1 AND movement_type = 'void_refund'`, [inv.id])).c, 1);
  });

  it('إلغاء بعد مرتجع جزئي: يرجّع المتبقي فقط ويرد المتبقي من المبلغ فقط', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 50, 20);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 10, price: 10 }] });   // 100
    const item = await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [inv.id]);
    const rr = await ret(item.id, 4, true);               // مرتجع 4 = 40 ج، رجعت للمخزون
    assert.equal(rr.refund_amount, 40);
    assert.equal(await T.batchQty(db, b), 14);

    const r = await voidInv(inv.id);
    assert.equal(r.restored_units, 6, 'المتبقي (المباع − المرتجع) بس');
    assert.equal(r.refund_due, 60);
    assert.equal(await T.batchQty(db, b), 20, 'مفيش زيادة عن الأصل');
    await T.assertStockMatches(assert, db, m);
  });

  it('مرتجع تالف (بدون إرجاع للمخزون) ثم إلغاء: التالف مبيرجعش للمخزون', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 50, 20);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 10, price: 10 }] });
    const item = await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [inv.id]);
    await ret(item.id, 3, false);                          // تالف
    await voidInv(inv.id);
    assert.equal(await T.batchQty(db, b), 17, '20 − 3 تالف');
    await T.assertStockMatches(assert, db, m);
  });

  it('تشغيلة انتهت قبل الإلغاء: متترجعش للمخزون الصالح، ويتسجل في التدقيق', async () => {
    const m = await T.addMedicine(db);
    const b = await T.addBatch(db, m, 5, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 10, price: 10 }] });
    await T.expireBatch(db, b, 1);
    const r = await voidInv(inv.id);
    assert.equal(r.restored_units, 0);
    assert.equal(r.expired_units, 10);
    assert.equal(await T.batchQty(db, b), 0);
    await T.assertStockMatches(assert, db, m);
  });

  it('مرتجع على فاتورة ملغاة مرفوض', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 2, price: 10 }] });
    const item = await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [inv.id]);
    await voidInv(inv.id);
    await T.rejectsWith(assert, ret(item.id, 1), 'PH001', 'ملغاة');
  });

  it('الحذف النهائي للفاتورة/البنود وتعديل البند وإرجاع الملغاة لمكتملة كلها مرفوضة', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 2, price: 10 }] });
    await T.rejectsWith(assert, db.q('DELETE FROM sale_invoices WHERE id = $1', [inv.id]), 'PH001', 'حذف الفواتير');
    await T.rejectsWith(assert, db.q('DELETE FROM sale_items WHERE invoice_id = $1', [inv.id]), 'PH001', 'حذف بنود');
    await T.rejectsWith(assert, db.q('UPDATE sale_items SET quantity = 99 WHERE invoice_id = $1', [inv.id]), 'PH001', 'تعديل بند');
    await voidInv(inv.id);
    await T.rejectsWith(assert, db.q(`UPDATE sale_invoices SET status = 'completed' WHERE id = $1`, [inv.id]), 'PH001');
    assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM sale_invoices WHERE id = $1', [inv.id])).c, 1);
  });

  it('السبب إجباري، والرد النقدي يتطلب وردية مفتوحة، وفاتورة غير موجودة 404', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 2, price: 10 }] });
    await T.rejectsWith(assert, voidInv(inv.id, '   '), 'PH001', 'سبب');
    // صيدلي من غير وردية مفتوحة
    await T.rejectsWith(assert, voidInv(inv.id, 'سبب', null, T.PHARMA), 'PH001', 'وردية');
    assert.equal((await db.q1('SELECT status FROM sale_invoices WHERE id = $1', [inv.id])).status, 'completed', 'فشل الإلغاء ممسحش حاجة (rollback)');
    assert.equal(await T.stock(db, m), 8);
    await T.rejectsWith(assert, voidInv(999999), 'PH002');
  });

  it('رد بدون نقدية (none) مسموح من غير وردية ومبيتسجلش حركة خزنة', async () => {
    const m = await T.addMedicine(db);
    await T.addBatch(db, m, 50, 10);
    const inv = await T.sell(db, { shift: cashierShift, items: [{ med: m, qty: 2, price: 10 }] });
    await voidInv(inv.id, 'سبب', 'none', T.PHARMA);
    assert.equal((await db.q1(`SELECT COUNT(*)::int AS c FROM cash_movements WHERE invoice_id = $1 AND movement_type = 'void_refund'`, [inv.id])).c, 0);
  });
});
