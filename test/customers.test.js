// اختبارات طبقة قاعدة البيانات للعملاء والبيع الآجل (migration_005):
// بيع آجل + حد الآجل، السداد (الخزنة)، المرتجعات والإلغاء على فواتير آجلة، وحماية الرصيد والدفتر.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('العملاء والبيع الآجل', { skip: T.SKIP }, () => {
  let db; let shift; let adminShift;

  before(async () => {
    db = await T.createTestDb('customers');
    shift = await T.openShift(db, T.CASHIER, 100);
    adminShift = await T.openShift(db, T.ADMIN, 0);
  });
  after(async () => { if (db) await db.drop(); });

  const newCustomer = async (name, limit = 1000, phone = null) =>
    (await db.q1(`INSERT INTO customers (name, phone, credit_limit) VALUES ($1, $2, $3) RETURNING id`, [name, phone, limit])).id;
  const medicine = async (stockQty = 100) => {
    const m = await T.addMedicine(db, { price: 100, cost: 40 });
    await T.addBatch(db, m, 365, stockQty, 40);
    return m;
  };
  const balance = async (id) => Number((await db.q1('SELECT balance FROM customers WHERE id = $1', [id])).balance);
  const itemId = async (invId) => (await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1 ORDER BY id LIMIT 1', [invId])).id;
  const cashOf = async (invId) => (await db.q('SELECT movement_type, amount FROM cash_movements WHERE invoice_id = $1 ORDER BY id', [invId]))
    .map((r) => [r.movement_type, Number(r.amount)]);
  const ledgerSum = async (id) => Number((await db.q1('SELECT COALESCE(SUM(amount),0) AS s FROM customer_ledger WHERE customer_id = $1', [id])).s);

  it('بيع آجل جزئي: النقدي في الخزنة بس، والباقي على حساب العميل (دفتر + رصيد)', async () => {
    const c = await newCustomer('أحمد', 500);
    const m = await medicine();
    const inv = await T.sell(db, { shift, customer: c, credit: 150, items: [{ med: m, qty: 2, price: 100 }] });
    assert.equal(inv.total, 200);
    assert.deepEqual(await cashOf(inv.id), [['sale', 50]]);
    assert.equal(await balance(c), 150);
    const row = await db.q1('SELECT credit_amount, credit_reversed FROM sale_invoices WHERE id = $1', [inv.id]);
    assert.equal(Number(row.credit_amount), 150);
    assert.equal(Number(row.credit_reversed), 0);
    const l = await db.q('SELECT entry_type, amount, balance_after FROM customer_ledger WHERE customer_id = $1', [c]);
    assert.deepEqual(l.map((x) => [x.entry_type, Number(x.amount), Number(x.balance_after)]), [['credit_sale', 150, 150]]);
    assert.equal(await ledgerSum(c), await balance(c));
  });

  it('بيع آجل بالكامل: مفيش حركة خزنة، والفاتورة متتسجلش مرتين', async () => {
    const c = await newCustomer('كامل آجل', 1000);
    const m = await medicine();
    const inv = await T.sell(db, { shift, customer: c, credit: 200, items: [{ med: m, qty: 2, price: 100 }] });
    assert.deepEqual(await cashOf(inv.id), []);
    assert.equal(await balance(c), 200);
    await T.rejectsWith(assert, db.q('SELECT finalize_sale_invoice($1, 0, $2, 0)', [inv.id, T.CASHIER]), 'PH003');
    assert.equal(await balance(c), 200, 'التكرار ميزودش المديونية');
  });

  it('تجاوز حد الآجل أو حد = 0 أو من غير عميل: يترفض والبيع كله يترجع', async () => {
    const m = await medicine(10);
    const before = await T.stock(db, m);
    const c = await newCustomer('حد صغير', 100);
    await T.rejectsWith(assert, T.sell(db, { shift, customer: c, credit: 150, items: [{ med: m, qty: 2, price: 100 }] }), 'PH001', 'حد الآجل');
    const noLimit = await newCustomer('بدون حد', 0);
    await T.rejectsWith(assert, T.sell(db, { shift, customer: noLimit, credit: 50, items: [{ med: m, qty: 1, price: 100 }] }), 'PH001', 'حد الآجل');
    await T.rejectsWith(assert, T.sell(db, { shift, customer: null, credit: 50, items: [{ med: m, qty: 1, price: 100 }] }), 'PH001', 'عميل مسجّل');
    assert.equal(await T.stock(db, m), before, 'المخزون رجع');
    assert.equal(await balance(c), 0);
  });

  it('الحد بيتحسب على المديونية الحالية + الجديدة، وعميل موقوف مينفعش يشتري آجل', async () => {
    const m = await medicine();
    const c = await newCustomer('تراكمي', 250);
    await T.sell(db, { shift, customer: c, credit: 200, items: [{ med: m, qty: 2, price: 100 }] });
    await T.rejectsWith(assert, T.sell(db, { shift, customer: c, credit: 100, items: [{ med: m, qty: 1, price: 100 }] }), 'PH001', 'حد الآجل');
    await T.sell(db, { shift, customer: c, credit: 50, items: [{ med: m, qty: 1, price: 100 }] });
    assert.equal(await balance(c), 250);
    await db.q('UPDATE customers SET is_active = false WHERE id = $1', [c]);
    await T.rejectsWith(assert, T.sell(db, { shift, customer: c, credit: 10, items: [{ med: m, qty: 1, price: 100 }] }), 'PH001', 'موقوف');
  });

  it('السداد النقدي: بيدخل درج الوردية (إيداع) ويقلل المديونية، ويرفض الزيادة عن المديونية أو من غير وردية', async () => {
    const c = await newCustomer('سداد', 1000);
    const m = await medicine();
    await T.sell(db, { shift, customer: c, credit: 200, items: [{ med: m, qty: 2, price: 100 }] });
    const before = (await db.q1('SELECT expected_cash FROM shift_summary($1)', [shift])).expected_cash;

    const r = (await db.q1(`SELECT record_customer_payment($1, 80, 'cash', 'دفعة', $2, 'cashier', 'pay-key-0001') AS r`, [c, T.CASHIER])).r;
    assert.equal(Number(r.balance), 120);
    assert.equal(await balance(c), 120);
    const after = (await db.q1('SELECT expected_cash FROM shift_summary($1)', [shift])).expected_cash;
    assert.equal(Number(after) - Number(before), 80, 'النقدي دخل الدرج');
    assert.equal(await ledgerSum(c), await balance(c));

    // نفس المفتاح: مفيش سداد مكرر
    const dup = (await db.q1(`SELECT record_customer_payment($1, 80, 'cash', 'دفعة', $2, 'cashier', 'pay-key-0001') AS r`, [c, T.CASHIER])).r;
    assert.equal(dup.duplicate, true);
    assert.equal(await balance(c), 120);

    await T.rejectsWith(assert, db.q(`SELECT record_customer_payment($1, 500, 'cash', NULL, $2, 'cashier')`, [c, T.CASHIER]), 'PH001', 'أكبر من المديونية');
    await T.rejectsWith(assert, db.q(`SELECT record_customer_payment($1, 0, 'cash', NULL, $2, 'cashier')`, [c, T.CASHIER]), 'PH001');
    await T.rejectsWith(assert, db.q(`SELECT record_customer_payment($1, 10, 'bitcoin', NULL, $2, 'cashier')`, [c, T.CASHIER]), 'PH001');
    // صيدلي من غير وردية مفتوحة
    await T.rejectsWith(assert, db.q(`SELECT record_customer_payment($1, 10, 'cash', NULL, $2, 'pharma')`, [c, T.PHARMA]), 'PH001', 'وردية');
    // بطاقة: بتتسجل على الحساب من غير ما تدخل الدرج النقدي
    await db.q(`SELECT record_customer_payment($1, 20, 'card', NULL, $2, 'pharma')`, [c, T.PHARMA]);
    assert.equal(await balance(c), 100);
    const after2 = (await db.q1('SELECT expected_cash FROM shift_summary($1)', [shift])).expected_cash;
    assert.equal(Number(after2), Number(after));
  });

  it('مرتجع على فاتورة آجلة: بيخصم من المديونية الأول، والنقدي بس لما المديونية تخلص', async () => {
    const c = await newCustomer('مرتجع', 1000);
    const m = await medicine();
    // 4 × 100 = 400: آجل 300 + نقدي 100
    const inv = await T.sell(db, { shift, customer: c, credit: 300, items: [{ med: m, qty: 4, price: 100 }] });
    const it = await itemId(inv.id);
    assert.equal(await balance(c), 300);

    // أول مرتجع 2 × 100 = 200 ← كله من المديونية (الآجل 300)
    const r1 = (await db.q1(`SELECT create_return($1, 2, 'test', true, 'cash', $2, 'cashier') AS r`, [it, T.CASHIER])).r;
    assert.equal(Number(r1.refund_amount), 200);
    assert.equal(Number(r1.credit_applied), 200);
    assert.equal(Number(r1.cash_refund), 0);
    assert.equal(await balance(c), 100);
    assert.deepEqual(await cashOf(inv.id), [['sale', 100]], 'مفيش رد نقدي');

    // تاني مرتجع 2 × 100 = 200 ← 100 من المديونية + 100 نقدي
    const r2 = (await db.q1(`SELECT create_return($1, 2, 'test', true, 'cash', $2, 'cashier') AS r`, [it, T.CASHIER])).r;
    assert.equal(Number(r2.credit_applied), 100);
    assert.equal(Number(r2.cash_refund), 100);
    assert.equal(await balance(c), 0);
    assert.deepEqual(await cashOf(inv.id), [['sale', 100], ['refund', -100]]);
    const row = await db.q1('SELECT credit_reversed FROM sale_invoices WHERE id = $1', [inv.id]);
    assert.equal(Number(row.credit_reversed), 300);
    const ret = await db.q('SELECT refund_amount, credit_applied FROM returns WHERE sale_item_id = $1 ORDER BY id', [it]);
    assert.deepEqual(ret.map((x) => [Number(x.refund_amount), Number(x.credit_applied)]), [[200, 200], [200, 100]]);
    assert.equal(await ledgerSum(c), await balance(c));
    await T.assertStockMatches(assert, db, m);
  });

  it('مرتجع آجل بدون وردية مفتوحة مسموح (مفيش نقدية)، لكن الجزء النقدي بيحتاج وردية', async () => {
    const c = await newCustomer('بدون وردية', 1000);
    const m = await medicine();
    const inv = await T.sell(db, { shift, customer: c, credit: 100, items: [{ med: m, qty: 2, price: 100 }] });
    const it = await itemId(inv.id);
    // الصيدلي معندوش وردية: مرتجع 1 (100) ← كله من الآجل
    const r = (await db.q1(`SELECT create_return($1, 1, 'x', true, 'cash', $2, 'pharma') AS r`, [it, T.PHARMA])).r;
    assert.equal(Number(r.credit_applied), 100);
    assert.equal(await balance(c), 0);
    // المرتجع التاني نقدي ← محتاج وردية
    await T.rejectsWith(assert, db.q(`SELECT create_return($1, 1, 'x', true, 'cash', $2, 'pharma')`, [it, T.PHARMA]), 'PH001', 'وردية');
  });

  it('إلغاء فاتورة آجلة: يلغي الآجل من المديونية ويرد النقدي المدفوع بس', async () => {
    const c = await newCustomer('إلغاء', 1000);
    const m = await medicine();
    const inv = await T.sell(db, { shift: adminShift, user: T.ADMIN, customer: c, credit: 150, items: [{ med: m, qty: 2, price: 100 }] });
    assert.equal(await balance(c), 150);
    const r = (await db.q1(`SELECT void_sale_invoice($1, $2, 'admin', 'غلط', NULL) AS r`, [inv.id, T.ADMIN])).r;
    assert.equal(Number(r.credit_cancelled), 150);
    assert.equal(Number(r.cash_refund), 50);
    assert.equal(await balance(c), 0);
    assert.deepEqual(await cashOf(inv.id), [['sale', 50], ['void_refund', -50]]);
    assert.equal(Number((await db.q1('SELECT credit_reversed FROM sale_invoices WHERE id = $1', [inv.id])).credit_reversed), 150);
    assert.equal(await ledgerSum(c), 0);
  });

  it('إلغاء بعد مرتجع جزئي وسداد جزئي: الحسابات متطابقة (الرصيد = مجموع الدفتر)', async () => {
    const c = await newCustomer('مركّب', 1000);
    const m = await medicine();
    const inv = await T.sell(db, { shift: adminShift, user: T.ADMIN, customer: c, credit: 300, items: [{ med: m, qty: 4, price: 100 }] });
    const it = await itemId(inv.id);
    await db.q(`SELECT create_return($1, 1, 'r', true, 'cash', $2, 'admin')`, [it, T.ADMIN]);          // آجل -100 ← 200
    await db.q(`SELECT record_customer_payment($1, 120, 'cash', NULL, $2, 'admin')`, [c, T.ADMIN]);     // سداد 120 ← 80
    assert.equal(await balance(c), 80);
    const r = (await db.q1(`SELECT void_sale_invoice($1, $2, 'admin', 'إلغاء', NULL) AS r`, [inv.id, T.ADMIN])).r;
    // المتبقي من الآجل على الفاتورة = 300 - 100 = 200، المتبقي للعميل = 400 - 100 = 300 ← 200 آجل + 100 نقدي
    assert.equal(Number(r.credit_cancelled), 200);
    assert.equal(Number(r.cash_refund), 100);
    // العميل سدّد 120 وبعدين اتلغى 200 ← رصيد دائن 120 له (80 - 200)
    assert.equal(await balance(c), -120);
    assert.equal(await ledgerSum(c), await balance(c));
    await T.assertStockMatches(assert, db, m);
  });

  it('حماية: الرصيد ميتعدلش مباشرة، والدفتر ميتعدلش ولا يتحذف، والعميل ذو الفواتير ميتحذفش', async () => {
    const c = await newCustomer('حماية', 1000);
    const m = await medicine();
    await T.sell(db, { shift, customer: c, credit: 100, items: [{ med: m, qty: 1, price: 100 }] });
    await T.rejectsWith(assert, db.q('UPDATE customers SET balance = 0 WHERE id = $1', [c]), 'PH001', 'مباشرة');
    await T.rejectsWith(assert, db.q('UPDATE customer_ledger SET amount = 1 WHERE customer_id = $1', [c]), 'PH001');
    await T.rejectsWith(assert, db.q('DELETE FROM customer_ledger WHERE customer_id = $1', [c]), 'PH001');
    await T.rejectsWith(assert, db.q('DELETE FROM customers WHERE id = $1', [c]), '23503');
    assert.equal(await balance(c), 100);
  });

  it('تسوية الرصيد: بسبب إجباري، بالزيادة (رصيد افتتاحي) أو النقص، وبتتسجل في الدفتر من غير أثر على الخزنة', async () => {
    const c = await newCustomer('تسوية', 1000);
    const cashBefore = Number((await db.q1('SELECT COUNT(*) AS n FROM cash_movements')).n);
    await T.rejectsWith(assert, db.q(`SELECT adjust_customer_balance($1, 100, '  ', $2, 'admin')`, [c, T.ADMIN]), 'PH001', 'سبب');
    await T.rejectsWith(assert, db.q(`SELECT adjust_customer_balance($1, 0, 'x', $2, 'admin')`, [c, T.ADMIN]), 'PH001');
    await db.q(`SELECT adjust_customer_balance($1, 350, 'رصيد افتتاحي من الدفتر الورقي', $2, 'admin')`, [c, T.ADMIN]);
    await db.q(`SELECT adjust_customer_balance($1, -50, 'خصم', $2, 'admin')`, [c, T.ADMIN]);
    assert.equal(await balance(c), 300);
    assert.equal(await ledgerSum(c), 300);
    assert.equal(Number((await db.q1('SELECT COUNT(*) AS n FROM cash_movements')).n), cashBefore);
  });

  it('رقم التليفون فريد بعد التنظيف من الرموز', async () => {
    await newCustomer('أول', 0, '0100-000-1111');
    await T.rejectsWith(assert, newCustomer('تاني', 0, '01000001111'), '23505');
    await T.rejectsWith(assert, newCustomer('تالت', 0, '+(010) 0000 1111'), '23505');
    await newCustomer('بدون رقم 1', 0, null);
    await newCustomer('بدون رقم 2', 0, null);
  });

  it('فاتورة بدون آجل (النظام القديم): نفس السلوك بالظبط', async () => {
    const m = await medicine();
    const inv = await T.sell(db, { shift, items: [{ med: m, qty: 2, price: 100 }] });
    assert.deepEqual(await cashOf(inv.id), [['sale', 200]]);
    const it = await itemId(inv.id);
    const r = (await db.q1(`SELECT create_return($1, 1, 'x', true, 'cash', $2, 'cashier') AS r`, [it, T.CASHIER])).r;
    assert.equal(Number(r.cash_refund), 100);
    assert.equal(Number(r.credit_applied), 0);
    assert.deepEqual(await cashOf(inv.id), [['sale', 200], ['refund', -100]]);
  });
});
