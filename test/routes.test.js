// اختبارات الـ routes الحقيقية (products / pos / returns / sales / shifts) عبر shim لـ express + قاعدة اختبار
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('routes', { skip: T.SKIP }, () => {
  let db; let app; let cashierShift; let adminShift; let pharmaShift;

  before(async () => {
    db = await T.createTestDb('routes');
    process.env.DATABASE_URL = db.url;
    const { startApp } = require('./helpers/app');
    app = await startApp({
      '/products': require('../routes/products'),
      '/pos': require('../routes/pos'),
      '/returns': require('../routes/returns'),
      '/sales': require('../routes/sales'),
      '/shifts': require('../routes/shifts')
    });
  });
  after(async () => { if (app) await app.close(); if (db) { await require('../db').pool.end(); await db.drop(); } });

  const future = (days = 365) => db.q1(`SELECT to_char(pharmacy_today() + $1::int, 'YYYY-MM-DD') AS d`, [days]).then((r) => r.d);
  const medByName = (name) => db.q1('SELECT * FROM medicines WHERE name = $1', [name]);

  describe('products', () => {
    it('إضافة صنف برصيد افتتاحي ← تشغيلة بتاريخ الصلاحية، والمخزون من التشغيلة', async () => {
      const exp = await future(400);
      const r = await app.request('POST', '/products/add', { user: T.ADMIN, form: { name: 'OpenMed', sale_price_unit: '5', cost_price_unit: '2', stock_unit_qty: '40', opening_expiry: exp } });
      assert.equal(r.status, 302, r.text);
      const m = await medByName('OpenMed');
      assert.equal(m.stock_units, 40);
      const b = await db.q('SELECT * FROM batches WHERE medicine_id = $1', [m.id]);
      assert.equal(b.length, 1);
      assert.equal(b[0].quantity_units, 40);
      assert.equal(b[0].received_units, 40);
      assert.equal(Number(b[0].cost_price_unit), 2);
      assert.equal((await db.q1(`SELECT to_char(expiry_date,'YYYY-MM-DD') AS e FROM batches WHERE id = $1`, [b[0].id])).e, exp);
      await T.assertStockMatches(assert, db, m.id);
      const mv = await db.q(`SELECT movement_type, quantity_units FROM stock_movements WHERE medicine_id = $1`, [m.id]);
      assert.deepEqual(mv.map((x) => [x.movement_type, x.quantity_units]), [['purchase', 40]]);
      // وقابل للبيع فعلاً
      const s = await T.openShift(db, T.CASHIER); cashierShift = s;
      await T.sell(db, { shift: s, items: [{ med: m.id, qty: 5, price: 5 }] });
      assert.equal(await T.stock(db, m.id), 35);
    });

    it('رصيد افتتاحي من غير تاريخ صلاحية، أو بتاريخ منتهي أو غير صالح: يترفض ومفيش صنف يتسجل', async () => {
      const past = await future(-3);
      for (const [name, exp, msg] of [['NoExp', undefined, 'تاريخ صلاحية'], ['PastExp', past, 'منتهي'], ['BadExp', '2026-02-31', 'تاريخ صلاحية']]) {
        const form = { name, sale_price_unit: '5', stock_unit_qty: '10' };
        if (exp) form.opening_expiry = exp;
        const r = await app.request('POST', '/products/add', { user: T.ADMIN, form });
        assert.equal(r.status, 400, `${name}: ${r.text}`);
        assert.ok(r.json.error.includes(msg), r.json.error);
        assert.equal(await medByName(name), null, 'الـ transaction اتلغت');
      }
    });

    it('صنف جديد بدون رصيد افتتاحي: بيتسجل بدون تشغيلة ولا يحتاج صلاحية', async () => {
      const r = await app.request('POST', '/products/add', { user: T.ADMIN, form: { name: 'NoStock', sale_price_unit: '5' } });
      assert.equal(r.status, 302);
      const m = await medByName('NoStock');
      assert.equal(m.stock_units, 0);
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM batches WHERE medicine_id = $1', [m.id])).c, 0);
    });

    it('الإضافة للأدمن فقط', async () => {
      const r = await app.request('POST', '/products/add', { user: T.PHARMA, form: { name: 'Nope', sale_price_unit: '5' } });
      assert.notEqual(r.status, 200);
      assert.equal(await medByName('Nope'), null);
    });

    it('stock_dirty: تسوية مسجلة (قبل/بعد/الفرق/السبب/المستخدم) على التشغيلات + تحديث البيانات في نفس الـ transaction', async () => {
      const m = await T.addMedicine(db, { name: 'AdjMed', price: 5 });
      const b1 = await T.addBatch(db, m, 30, 10);
      const b2 = await T.addBatch(db, m, 90, 10);
      // نقص من 20 لـ 12: بيتخصم من الأقرب صلاحية
      let r = await app.request('POST', `/products/${m}/update`, { user: T.ADMIN, form: { name: 'AdjMed2', sale_price_unit: '6', stock_dirty: '1', stock_unit_qty: '12' } });
      assert.equal(r.status, 302, r.text);
      assert.equal(await T.batchQty(db, b1), 2);
      assert.equal(await T.batchQty(db, b2), 10);
      const adj = await db.q1('SELECT * FROM stock_adjustments WHERE medicine_id = $1', [m]);
      assert.deepEqual([adj.quantity_before, adj.quantity_after, adj.difference, adj.created_by], [20, 12, -8, T.ADMIN]);
      assert.ok(adj.reason);
      assert.equal((await db.q1('SELECT name FROM medicines WHERE id = $1', [m])).name, 'AdjMed2');
      // زيادة: على أطول تشغيلة صالحة
      r = await app.request('POST', `/products/${m}/update`, { user: T.ADMIN, form: { name: 'AdjMed2', sale_price_unit: '6', stock_dirty: '1', stock_unit_qty: '20' } });
      assert.equal(r.status, 302);
      assert.equal(await T.batchQty(db, b2), 18);
      await T.assertStockMatches(assert, db, m);
      const a = await db.q1(`SELECT details FROM activity_log WHERE action = 'تسوية مخزون' ORDER BY id DESC LIMIT 1`);
      assert.equal(JSON.parse(a.details).difference, 8);
    });

    it('تعديل بيانات بدون stock_dirty مبيلمسش المخزون ولا بيعمل تسوية', async () => {
      const m = await T.addMedicine(db, { name: 'NoDirty' });
      await T.addBatch(db, m, 30, 7);
      const r = await app.request('POST', `/products/${m}/update`, { user: T.ADMIN, form: { name: 'NoDirty', sale_price_unit: '9', stock_dirty: '0', stock_unit_qty: '999' } });
      assert.equal(r.status, 302);
      assert.equal(await T.stock(db, m), 7);
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM stock_adjustments WHERE medicine_id = $1', [m])).c, 0);
    });

    it('زيادة مخزون بدون أي تشغيلة صالحة: ترفض ومفيش حاجة تتغير (حتى الاسم/السعر — rollback)', async () => {
      const m = await T.addMedicine(db, { name: 'NoValid', price: 3 });
      await T.addBatch(db, m, -5, 4);        // منتهية بس
      const r = await app.request('POST', `/products/${m}/update`, { user: T.ADMIN, form: { name: 'Renamed', sale_price_unit: '77', stock_dirty: '1', stock_unit_qty: '50' } });
      assert.equal(r.status, 400, r.text);
      assert.ok(r.json.error.includes('تشغيلة صالحة'));
      const row = await db.q1('SELECT name, sale_price_unit FROM medicines WHERE id = $1', [m]);
      assert.deepEqual([row.name, Number(row.sale_price_unit)], ['NoValid', 3]);
      assert.equal(await T.stock(db, m), 4);
    });

    it('batches/add: الكاشير ممنوع (403)، والصيدلي والأدمن مسموح', async () => {
      const m = await T.addMedicine(db, { name: 'BatchMed' });
      const exp = await future(200);
      const form = { medicine_id: String(m), expiry_date: exp, received_units: '25', cost_price_unit: '3.5', batch_number: 'LOT1' };
      let r = await app.request('POST', '/products/batches/add', { user: T.CASHIER, form });
      assert.equal(r.status, 403);
      assert.equal(await T.stock(db, m), 0);
      r = await app.request('POST', '/products/batches/add', { user: T.PHARMA, form });
      assert.equal(r.status, 302, r.text);
      r = await app.request('POST', '/products/batches/add', { user: T.ADMIN, form: { ...form, batch_number: 'LOT2' } });
      assert.equal(r.status, 302);
      assert.equal(await T.stock(db, m), 50);
      await T.assertStockMatches(assert, db, m);
    });

    it('batches/add: كمية ≤ 0 / كسرية، تكلفة سالبة، صلاحية منتهية أو غير صالحة، صنف ناقص: كلها 400', async () => {
      const m = await T.addMedicine(db, { name: 'BatchBad' });
      const exp = await future(200);
      const ok = { medicine_id: String(m), expiry_date: exp, received_units: '5', cost_price_unit: '1' };
      const bad = [
        { ...ok, received_units: '0' }, { ...ok, received_units: '-3' }, { ...ok, received_units: '2.5' }, { ...ok, received_units: 'abc' },
        { ...ok, cost_price_unit: '-1' }, { ...ok, cost_price_unit: 'x' },
        { ...ok, expiry_date: await future(-1) }, { ...ok, expiry_date: '2026-13-01' }, { ...ok, expiry_date: '' },
        { ...ok, medicine_id: '' }, { ...ok, medicine_id: '999999' }
      ];
      for (const form of bad) {
        const r = await app.request('POST', '/products/batches/add', { user: T.PHARMA, form });
        assert.ok([400, 404].includes(r.status), `${JSON.stringify(form)} → ${r.status}`);
      }
      assert.equal(await T.stock(db, m), 0);
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM batches WHERE medicine_id = $1', [m])).c, 0);
      // تكلفة صفر مسموحة (>= 0)
      const r = await app.request('POST', '/products/batches/add', { user: T.PHARMA, form: { ...ok, cost_price_unit: '0' } });
      assert.equal(r.status, 302, r.text);
    });
  });

  describe('pos / returns / sales', () => {
    let med; let invoiceId; let itemId; let freeSales = 0;

    before(async () => {
      pharmaShift = await T.openShift(db, T.PHARMA);
      adminShift = await T.openShift(db, T.ADMIN);
      med = await T.addMedicine(db, { name: 'PosMed', price: 10 });
      await T.addBatch(db, med, -2, 100);          // منتهية
      await T.addBatch(db, med, 60, 10);           // صالحة
    });

    it('البحث بيعرض المخزون الصالح فقط (مش المنتهي)', async () => {
      const r = await app.request('GET', '/pos/search?q=PosMed', { user: T.CASHIER });
      assert.equal(r.status, 200);
      const row = r.json.results.find((x) => x.name === 'PosMed');
      assert.equal(row.stock_units, 10);
      assert.equal(row.stock_total_units, 110);
    });

    it('checkout بدون وردية مفتوحة مرفوض ولا ينشئ فاتورة ولا يخصم مخزون', async () => {
      const n = (await db.q1('SELECT COUNT(*)::int AS c FROM sale_invoices')).c;
      const r = await app.request('POST', '/pos/checkout', { user: 4, body: { items: [{ medicine_id: med, quantity: 1 }] } });   // كاشير 2 مالوش وردية
      assert.equal(r.status, 400);
      assert.ok(r.json.error.includes('وردية'));
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM sale_invoices')).c, n);
      assert.equal(await T.stock(db, med), 110);
    });

    it('checkout ناجح + نفس مفتاح الـ idempotency مبيبيعش مرتين', async () => {
      const body = { items: [{ medicine_id: med, sale_unit: 'unit', quantity: 4 }], payment_method: 'cash', idempotency_key: 'idem-key-0001' };
      const r1 = await app.request('POST', '/pos/checkout', { user: T.CASHIER, body });
      assert.equal(r1.status, 200, r1.text);
      invoiceId = r1.json.invoiceId;
      const r2 = await app.request('POST', '/pos/checkout', { user: T.CASHIER, body });
      assert.equal(r2.status, 200);
      assert.equal(r2.json.invoiceId, invoiceId);
      assert.equal(r2.json.duplicate, true);
      assert.equal(await T.stock(db, med), 106);
      assert.equal((await db.q1(`SELECT COUNT(*)::int AS c FROM sale_invoices WHERE idempotency_key = 'idem-key-0001'`)).c, 1);
      const inv = await db.q1('SELECT total, shift_id FROM sale_invoices WHERE id = $1', [invoiceId]);
      assert.equal(Number(inv.total), 40);
      assert.equal(inv.shift_id, cashierShift);
      itemId = (await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [invoiceId])).id;
    });

    it('checkout بكمية أكبر من الصالح (الباقي منتهي) يرجع 400 برسالة واضحة ولا ينشئ فاتورة', async () => {
      const before = (await db.q1('SELECT COUNT(*)::int AS c FROM sale_invoices')).c;
      const r = await app.request('POST', '/pos/checkout', { user: T.CASHIER, body: { items: [{ medicine_id: med, quantity: 7 }], payment_method: 'cash' } });
      assert.equal(r.status, 400);
      assert.ok(r.json.error.includes('الكمية الصالحة'));
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM sale_invoices')).c, before);
    });

    it('الخصم الأكبر من الإجمالي بيتحدد بالإجمالي (إجمالي صفر مش سالب)، والخصم السالب مبيزودش السعر', async () => {
      let r = await app.request('POST', '/pos/checkout', { user: T.CASHIER, body: { items: [{ medicine_id: med, quantity: 1 }], discount_amount: 1000 } });
      assert.equal(r.status, 200, r.text);
      let inv = await db.q1('SELECT total, discount FROM sale_invoices WHERE id = $1', [r.json.invoiceId]);
      assert.deepEqual([Number(inv.total), Number(inv.discount)], [0, 10]);
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM cash_movements WHERE invoice_id = $1', [r.json.invoiceId])).c, 0, 'مفيش حركة خزنة بصفر');
      r = await app.request('POST', '/pos/checkout', { user: T.CASHIER, body: { items: [{ medicine_id: med, quantity: 1 }], discount_amount: -50 } });
      assert.equal(r.status, 200);
      inv = await db.q1('SELECT total, discount FROM sale_invoices WHERE id = $1', [r.json.invoiceId]);
      assert.deepEqual([Number(inv.total), Number(inv.discount)], [10, 0]);
      freeSales = 2;
    });

    it('المرتجعات: الكاشير ممنوع 403، والصيدلي مسموح', async () => {
      let r = await app.request('POST', '/returns/add', { user: T.CASHIER, form: { sale_item_id: String(itemId), quantity: '1', refund_method: 'cash' } });
      assert.equal(r.status, 403);
      r = await app.request('POST', '/returns/add', { user: T.PHARMA, form: { sale_item_id: String(itemId), quantity: '1', refund_method: 'cash', idempotency_key: 'ret-aaaaaaaa-1', restock: 'on' } });
      assert.equal(r.status, 302, r.text);
      // تكرار الضغط بنفس المفتاح
      r = await app.request('POST', '/returns/add', { user: T.PHARMA, form: { sale_item_id: String(itemId), quantity: '1', refund_method: 'cash', idempotency_key: 'ret-aaaaaaaa-1', restock: 'on' } });
      assert.equal(r.status, 302);
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM returns WHERE sale_item_id = $1', [itemId])).c, 1);
      // تجاوز الكمية
      r = await app.request('POST', '/returns/add', { user: T.PHARMA, form: { sale_item_id: String(itemId), quantity: '4', idempotency_key: 'ret-aaaaaaaa-2' } });
      assert.equal(r.status, 400);
      assert.ok(r.text.includes('المتبقي: 3'));
      await T.assertStockMatches(assert, db, med);
    });

    it('الإلغاء: الكاشير والصيدلي ممنوعين (الفاتورة تفضل مكتملة)، والأدمن مسموح', async () => {
      for (const u of [T.CASHIER, T.PHARMA]) {
        const r = await app.request('POST', `/sales/${invoiceId}/void`, { user: u, form: { reason: 'تجربة' } });
        assert.equal(r.status, 302);
        assert.equal(r.location, '/pos', 'غير الأدمن بيتحوّل ومبيتنفذش');
        assert.equal((await db.q1('SELECT status FROM sale_invoices WHERE id = $1', [invoiceId])).status, 'completed');
      }
      let r = await app.request('POST', `/sales/${invoiceId}/void`, { user: T.ADMIN, form: { reason: '' } });
      assert.equal(r.status, 400);
      r = await app.request('POST', `/sales/${invoiceId}/void`, { user: T.ADMIN, form: { reason: 'تجربة' } });
      assert.equal(r.status, 302);
      assert.equal(r.location, '/sales');
      assert.equal((await db.q1('SELECT status FROM sale_invoices WHERE id = $1', [invoiceId])).status, 'voided');
      r = await app.request('POST', `/sales/${invoiceId}/void`, { user: T.ADMIN, form: { reason: 'تاني' } });
      assert.equal(r.status, 409);
      // المسار القديم /delete = إلغاء مش حذف
      assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM sale_invoices WHERE id = $1', [invoiceId])).c, 1);
      await T.assertStockMatches(assert, db, med);
      // المنتهي 100 لسه زي ما هو + الصالح: 10 − (بيعتين تانيين في اختبار الخصم) = 8 (فاتورة الـ 4 اتلغت ورجعت)
      assert.equal(await T.stock(db, med), 100 + 10 - freeSales, 'المخزون رجع للفاتورة الملغاة مرة واحدة بس');
    });
  });

  describe('shifts', () => {
    it('نقدية الوردية: المتوقع من الحركات الفعلية، سحب أكبر من المتاح مرفوض، الإغلاق بعجز، والإغلاق المزدوج مرفوض', async () => {
      const u = T.PHARMA;
      await db.q('UPDATE shifts SET closed_at = now(), closing_balance = 0 WHERE opened_by = $1 AND closed_at IS NULL', [u]);
      let r = await app.request('POST', '/shifts/start', { user: u, form: { opening_balance: '100' } });
      assert.equal(r.status, 302, r.text);
      r = await app.request('POST', '/shifts/start', { user: u, form: { opening_balance: '5' } });
      assert.equal(r.status, 400, 'وردية مفتوحة واحدة بس لكل مستخدم');
      const sh = await db.q1('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [u]);

      const m = await T.addMedicine(db, { name: 'ShiftMed', price: 10 });
      await T.addBatch(db, m, 90, 100);
      const cash = await T.sell(db, { user: u, shift: sh.id, items: [{ med: m, qty: 5, price: 10 }] });          // +50 نقدي
      await T.sell(db, { user: u, shift: sh.id, items: [{ med: m, qty: 3, price: 10 }], method: 'card' });       // +30 بطاقة
      const item = await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [cash.id]);
      await db.q1('SELECT create_return($1,1,$2,true,NULL,$3,$4,NULL)', [item.id, 'سبب', u, 'pharma']);          // −10 نقدي
      r = await app.request('POST', '/shifts/cash', { user: u, form: { type: 'deposit', amount: '20', note: 'فكة' } });
      assert.equal(r.status, 302, r.text);
      r = await app.request('POST', '/shifts/cash', { user: u, form: { type: 'withdrawal', amount: '15' } });
      assert.equal(r.status, 302);

      const page = await app.request('GET', '/shifts', { user: u });
      assert.equal(page.status, 200, page.text);
      const s = page.json.summary;
      assert.deepEqual([s.opening_balance, s.cash_sales, s.card_sales, s.cash_refunds, s.deposits, s.withdrawals, s.expected_cash],
        [100, 50, 30, 10, 20, 15, 145]);
      assert.equal(page.json.liveSalesTotal, 80);

      r = await app.request('POST', '/shifts/cash', { user: u, form: { type: 'withdrawal', amount: '1000' } });
      assert.equal(r.status, 400);
      r = await app.request('POST', '/shifts/cash', { user: u, form: { type: 'withdrawal', amount: '-5' } });
      assert.equal(r.status, 400);
      r = await app.request('POST', '/shifts/cash', { user: u, form: { type: 'bogus', amount: '5' } });
      assert.equal(r.status, 400);

      r = await app.request('POST', '/shifts/close', { user: u, form: { closing_balance: '140' } });
      assert.equal(r.status, 302, r.text);
      const closed = await db.q1('SELECT expected_cash, closing_balance, cash_difference, closed_by FROM shifts WHERE id = $1', [sh.id]);
      assert.deepEqual([Number(closed.expected_cash), Number(closed.closing_balance), Number(closed.cash_difference), closed.closed_by], [145, 140, -5, u]);
      r = await app.request('POST', '/shifts/close', { user: u, form: { closing_balance: '140' } });
      assert.equal(r.status, 400, 'مفيش وردية مفتوحة');
      // الإغلاق المزدوج على مستوى الدالة (سباق)
      await T.rejectsWith(assert, db.q('SELECT close_shift($1,$2,$3,$4,NULL)', [sh.id, u, 'pharma', 140]), 'PH003');
      // الوردية المقفولة مبتقبلش حركات ولا مبيعات
      await T.rejectsWith(assert, db.q(`SELECT record_shift_cash($1,$2,'x','deposit',5,NULL)`, [sh.id, u]), 'PH003');
      const hist = await app.request('GET', '/shifts', { user: u });
      const row = hist.json.pastShifts.find((x) => x.id === sh.id);
      assert.equal(Number(row.cash_difference), -5);
    });

    it('الإغلاق المتوازي لنفس الوردية: واحد بس ينجح (جلستين psql)', async () => {
      const sh = (await db.q1('SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL', [T.ADMIN])).id;
      const sql = `SELECT close_shift(${sh}, ${T.ADMIN}, 'admin', 50, NULL);`;
      const [a, b] = await Promise.all([T.psql(db.url, sql), T.psql(db.url, sql)]);
      assert.equal([a, b].filter((x) => x.code === 0).length, 1, JSON.stringify([a, b]));
    });

    it('الحضور/الانصراف بتاريخ الصيدلية مش UTC', async () => {
      const utcHour = new Date().getUTCHours();
      const tz = utcHour < 11 ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';   // تاريخ مختلف عن UTC دايمًا
      await db.q(`INSERT INTO settings (key, value) VALUES ('timezone', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [tz]);
      const utcDate = new Date().toISOString().slice(0, 10);
      const local = (await db.q1(`SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS d`)).d;
      assert.notEqual(local, utcDate, 'الإعداد لازم يطلع تاريخ مختلف عن UTC عشان الاختبار يكون له معنى');
      await db.q(`UPDATE users SET employee_id = 77 WHERE id = $1`, [T.CASHIER]);
      await db.q('UPDATE shifts SET closed_at = now(), closing_balance = 0 WHERE opened_by = $1 AND closed_at IS NULL', [T.CASHIER]);
      const r = await app.request('POST', '/shifts/start', { user: T.CASHIER, form: { opening_balance: '0' } });
      assert.equal(r.status, 302, r.text);
      const att = await db.q1(`SELECT to_char(attendance_date,'YYYY-MM-DD') AS d, check_in FROM attendance WHERE employee_id = 77`);
      assert.equal(att.d, local);
      assert.match(att.check_in, /^\d{2}:\d{2}$/);
      await db.q(`DELETE FROM settings WHERE key = 'timezone'`);
    });
  });
});
