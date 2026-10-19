// اختبارات فواتير الشراء وحسابات الموردين
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('فواتير الشراء وحسابات الموردين', { skip: T.SKIP }, () => {
  let db; let sup;
  const future = (days) => db.q1(`SELECT to_char(pharmacy_today() + $1::int, 'YYYY-MM-DD') AS d`, [days]).then((r) => r.d);
  const create = async (o = {}) => {
    const items = o.items || [];
    const r = await db.q1(
      `SELECT create_purchase_invoice($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) AS id`,
      [o.supplier ?? sup, o.number ?? null, o.date ?? null, o.due ?? null, o.notes ?? null, T.ADMIN, 'admin',
       JSON.stringify(items), o.paid ?? 0, o.method ?? 'cash', o.key ?? null]);
    return r.id;
  };
  const pay = (supplier, invoice, amount, method = 'cash') =>
    db.q1('SELECT record_supplier_payment($1,$2,$3,$4,$5,$6,$7) AS r', [supplier, invoice, amount, method, null, T.ADMIN, 'admin']).then((r) => r.r);
  const stock = (m) => db.q1('SELECT stock_units FROM medicines WHERE id = $1', [m]).then((r) => r.stock_units);
  const inv = (id) => db.q1('SELECT * FROM purchase_invoices WHERE id = $1', [id]);
  const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message));

  before(async () => {
    db = await T.createTestDb('purch');
    sup = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد أ') RETURNING id`)).id;
  });
  after(async () => { if (db) await db.drop(); });

  it('فاتورة بالعلبة: تحويل للحبة، تشغيلة، مخزون، حركة، وإجمالي صحيح', async () => {
    const m = await T.addMedicine(db, { ups: 10, spb: 3 }); // العلبة = 30 حبة
    const id = await create({ number: 'INV-1', items: [{ medicine_id: m, unit: 'box', quantity: 2, cost: 100, expiry_date: await future(365), batch_number: 'L1' }] });
    const i = await inv(id);
    assert.equal(Number(i.total_amount), 200);
    assert.equal(await stock(m), 60);
    const it = await db.q1('SELECT * FROM purchase_invoice_items WHERE invoice_id = $1', [id]);
    assert.equal(it.quantity_units, 60);
    assert.equal(Number(it.cost_price_unit), 3.3333);
    const b = await db.q1('SELECT * FROM batches WHERE id = $1', [it.batch_id]);
    assert.equal(b.quantity_units, 60);
    assert.equal(b.purchase_invoice_id, id);
    assert.equal(b.supplier_id, sup);
    const mv = await db.q1(`SELECT * FROM stock_movements WHERE batch_id = $1 AND movement_type = 'purchase'`, [b.id]);
    assert.equal(mv.quantity_units, 60);
    const audit = await db.q1(`SELECT 1 FROM activity_log WHERE action = 'تسجيل فاتورة شراء'`);
    assert.ok(audit);
  });

  it('وحدات مختلفة: شريط وحبة', async () => {
    const m = await T.addMedicine(db, { ups: 10, spb: 3 });
    await create({ items: [
      { medicine_id: m, unit: 'strip', quantity: 3, cost: 20, expiry_date: await future(200) },
      { medicine_id: m, unit: 'unit', quantity: 5, cost: 2, expiry_date: await future(300) }] });
    assert.equal(await stock(m), 35);
  });

  it('التحقق: كمية صفر، سعر سالب، صلاحية منتهية، صنف غير موجود، قائمة فاضية، مورد غير موجود', async () => {
    const m = await T.addMedicine(db);
    const ok = { medicine_id: m, unit: 'unit', quantity: 5, cost: 1, expiry_date: await future(100) };
    await rejects(create({ items: [{ ...ok, quantity: 0 }] }), /الكمية/);
    await rejects(create({ items: [{ ...ok, quantity: 1.5 }] }), /بيانات غير صحيحة/);
    await rejects(create({ items: [{ ...ok, cost: -1 }] }), /السعر/);
    await rejects(create({ items: [{ ...ok, expiry_date: await future(-1) }] }), /الصلاحية/);
    await rejects(create({ items: [{ ...ok, expiry_date: 'abc' }] }), /بيانات غير صحيحة/);
    await rejects(create({ items: [{ ...ok, medicine_id: 999999 }] }), /الصنف/);
    await rejects(create({ items: [{ ...ok, unit: 'carton' }] }), /وحدة/);
    await rejects(create({ items: [] }), /صنف واحد/);
    await rejects(create({ items: [ok], supplier: 999999 }), /المورد/);
    await rejects(create({ items: [ok], paid: 6 }), /أكبر من إجمالي/);
    assert.equal(await stock(m), 0, 'ولا حاجة اتسجلت (rollback كامل)');
  });

  it('فشل بند في الآخر يلغي الفاتورة كلها (atomic)', async () => {
    const m = await T.addMedicine(db);
    const before = (await db.q1('SELECT COUNT(*)::int AS c FROM purchase_invoices')).c;
    await rejects(create({ items: [
      { medicine_id: m, unit: 'unit', quantity: 5, cost: 1, expiry_date: await future(100) },
      { medicine_id: m, unit: 'unit', quantity: 0, cost: 1, expiry_date: await future(100) }] }), /البند رقم 2/);
    assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM purchase_invoices')).c, before);
    assert.equal(await stock(m), 0);
  });

  it('رقم فاتورة المورد ومفتاح منع التكرار', async () => {
    const m = await T.addMedicine(db);
    const items = [{ medicine_id: m, unit: 'unit', quantity: 5, cost: 1, expiry_date: await future(100) }];
    await create({ number: 'DUP-1', items });
    await rejects(create({ number: 'dup-1', items }), /متسجل قبل كده/);
    const sup2 = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد ب') RETURNING id`)).id;
    await create({ number: 'DUP-1', items, supplier: sup2 }); // مورد تاني: مسموح
    await create({ items, key: 'idem-key-0001' });
    await rejects(create({ items, key: 'idem-key-0001' }), /اتسجلت قبل كده/);
    assert.equal(await stock(m), 15);
  });

  it('الدفع: جزئي وقت الاستلام ثم دفعات، ولا يتجاوز المتبقي', async () => {
    const m = await T.addMedicine(db);
    const id = await create({ items: [{ medicine_id: m, unit: 'unit', quantity: 10, cost: 10, expiry_date: await future(100) }], paid: 30 });
    assert.equal(Number((await inv(id)).paid_amount), 30);
    await pay(sup, id, 50);
    assert.equal(Number((await inv(id)).paid_amount), 80);
    await rejects(pay(sup, id, 25), /أكبر من المتبقي/);
    await rejects(pay(sup, id, 0), /أكبر من صفر/);
    await rejects(pay(sup, id, 10, 'visa'), /طريقة الدفع/);
    await pay(sup, id, 20);
    assert.equal(Number((await inv(id)).paid_amount), 100);
    const n = (await db.q1('SELECT COUNT(*)::int AS c FROM supplier_payments WHERE invoice_id = $1', [id])).c;
    assert.equal(n, 3);
  });

  it('دفعة على الحساب بتتوزع على الأقدم أولًا، وبترفض الزيادة', async () => {
    const s = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد ج') RETURNING id`)).id;
    const m = await T.addMedicine(db);
    const mk = (date, qty) => create({ supplier: s, date, items: [{ medicine_id: m, unit: 'unit', quantity: qty, cost: 10, expiry_date: '2099-01-01' }] });
    const older = await mk(await future(-10), 10);  // 100
    const newer = await mk(await future(-2), 5);    // 50
    const r = await pay(s, null, 120);
    assert.equal(r.length, 2);
    assert.equal(Number((await inv(older)).paid_amount), 100);
    assert.equal(Number((await inv(newer)).paid_amount), 20);
    await rejects(pay(s, null, 31), /أكبر من إجمالي المستحق/);
    const bal = await db.q1('SELECT * FROM v_supplier_balances WHERE supplier_id = $1', [s]);
    assert.equal(Number(bal.total_invoiced), 150);
    assert.equal(Number(bal.total_paid), 120);
    assert.equal(Number(bal.balance_due), 30);
    await pay(s, null, 30);
    assert.equal(Number((await db.q1('SELECT balance_due FROM v_supplier_balances WHERE supplier_id = $1', [s])).balance_due), 0);
  });

  it('دفعة لفاتورة مورد تاني مرفوضة', async () => {
    const other = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد د') RETURNING id`)).id;
    const m = await T.addMedicine(db);
    const id = await create({ items: [{ medicine_id: m, unit: 'unit', quantity: 1, cost: 10, expiry_date: '2099-01-01' }] });
    await rejects(pay(other, id, 5), /غير موجودة لهذا المورد/);
  });

  it('المتأخر: due_date فات ولسه فيه متبقي', async () => {
    const s = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد هـ') RETURNING id`)).id;
    const m = await T.addMedicine(db);
    await create({ supplier: s, date: await future(-30), due: await future(-5), items: [{ medicine_id: m, unit: 'unit', quantity: 10, cost: 10, expiry_date: '2099-01-01' }], paid: 40 });
    await create({ supplier: s, due: await future(10), items: [{ medicine_id: m, unit: 'unit', quantity: 1, cost: 10, expiry_date: '2099-01-01' }] });
    const bal = await db.q1('SELECT * FROM v_supplier_balances WHERE supplier_id = $1', [s]);
    assert.equal(Number(bal.balance_due), 70);
    assert.equal(Number(bal.overdue_due), 60);
    await rejects(create({ supplier: s, date: await future(-1), due: await future(-3), items: [{ medicine_id: m, unit: 'unit', quantity: 1, cost: 1, expiry_date: '2099-01-01' }] }), /الاستحقاق/);
  });

  it('الإلغاء: يعكس المخزون ويسجل حركة، ويتسجل كملغاة وتخرج من الرصيد', async () => {
    const s = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد و') RETURNING id`)).id;
    const m = await T.addMedicine(db);
    const id = await create({ supplier: s, number: 'C-1', items: [{ medicine_id: m, unit: 'unit', quantity: 10, cost: 10, expiry_date: '2099-01-01' }] });
    assert.equal(await stock(m), 10);
    await rejects(db.q('SELECT cancel_purchase_invoice($1,$2,$3,$4)', [id, T.ADMIN, 'admin', ' ']), /سبب الإلغاء/);
    await db.q('SELECT cancel_purchase_invoice($1,$2,$3,$4)', [id, T.ADMIN, 'admin', 'غلطة إدخال']);
    assert.equal(await stock(m), 0);
    assert.equal((await inv(id)).status, 'cancelled');
    const mv = await db.q1(`SELECT quantity_units FROM stock_movements WHERE movement_type = 'purchase_cancel' AND ref_id = $1`, [id]);
    assert.equal(mv.quantity_units, -10);
    await T.assertStockMatches(assert, db, m);
    await rejects(db.q('SELECT cancel_purchase_invoice($1,$2,$3,$4)', [id, T.ADMIN, 'admin', 'تاني']), /ملغاة بالفعل/);
    await rejects(pay(s, id, 5), /ملغاة/);
    assert.equal(Number((await db.q1('SELECT balance_due FROM v_supplier_balances WHERE supplier_id = $1', [s])).balance_due), 0);
    // رقم الفاتورة الملغاة ينفع يتسجل تاني
    await create({ supplier: s, number: 'C-1', items: [{ medicine_id: m, unit: 'unit', quantity: 1, cost: 1, expiry_date: '2099-01-01' }] });
  });

  it('الإلغاء مرفوض لو اتباع جزء من التشغيلة أو فيه دفعات', async () => {
    const m = await T.addMedicine(db);
    const id = await create({ items: [{ medicine_id: m, unit: 'unit', quantity: 10, cost: 5, expiry_date: '2099-01-01' }] });
    const shift = await T.openShift(db, T.CASHIER);
    await T.sell(db, { shift, items: [{ med: m, qty: 2, price: 10 }] });
    await rejects(db.q('SELECT cancel_purchase_invoice($1,$2,$3,$4)', [id, T.ADMIN, 'admin', 'x']), /اتباع أو اتعدّل/);
    assert.equal((await inv(id)).status, 'received');

    const id2 = await create({ items: [{ medicine_id: m, unit: 'unit', quantity: 3, cost: 5, expiry_date: '2099-01-01' }], paid: 5 });
    await rejects(db.q('SELECT cancel_purchase_invoice($1,$2,$3,$4)', [id2, T.ADMIN, 'admin', 'x']), /عليها دفعات/);
  });

  it('متوسط التكلفة المرجّح بيتحدّث من فاتورة الشراء', async () => {
    const m = await T.addMedicine(db);
    await create({ items: [{ medicine_id: m, unit: 'unit', quantity: 10, cost: 10, expiry_date: '2099-01-01' }] });
    await create({ items: [{ medicine_id: m, unit: 'unit', quantity: 10, cost: 20, expiry_date: '2099-01-01' }] });
    assert.equal(Number((await db.q1('SELECT cost_price_unit FROM medicines WHERE id = $1', [m])).cost_price_unit), 15);
  });
});
