// اختبارات الـ routes الجديدة (عملاء / آجل في الكاشير / رقابة / جرد / نواقص / تحليلات) على سيرفر حقيقي
// بـ views حقيقية (EJS) وجلسة مزيفة: بتتأكد إن كل شاشة بترسم من غير أخطاء وإن المنطق شغال.
const path = require('path');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const T = require('./helpers/db');

const USERS = { 1: { role: 'admin', username: 'admin' }, 2: { role: 'pharmacist', username: 'pharma' }, 3: { role: 'cashier', username: 'cashier' } };

describe('الشاشات والـ routes الجديدة', { skip: T.SKIP }, () => {
  let db; let server; let base; let cashierShift; let adminShift;

  before(async () => {
    db = await T.createTestDb('features');
    process.env.DATABASE_URL = db.url;
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use((req, res, next) => {
      const uid = parseInt(req.get('x-test-user'), 10);
      req.session = USERS[uid] ? { userId: uid, ...USERS[uid] } : {};
      res.locals.username = req.session.username || null;
      res.locals.role = req.session.role || null;
      res.locals.shopName = 'صيدلية';
      res.locals.scConfig = { keys: {}, nav: {} };
      next();
    });
    app.use('/pos', require('../routes/pos'));
    app.use('/sales', require('../routes/sales'));
    app.use('/returns', require('../routes/returns'));
    app.use('/customers', require('../routes/customers'));
    app.use('/reorder', require('../routes/reorder'));
    app.use('/stocktake', require('../routes/stocktake'));
    app.use('/controlled', require('../routes/controlled'));
    app.use('/insights', require('../routes/insights'));
    app.use((err, req, res, next) => { res.status(500).send('UNHANDLED: ' + (err && err.stack)); }); // eslint-disable-line no-unused-vars
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    cashierShift = await T.openShift(db, T.CASHIER, 0);
    adminShift = await T.openShift(db, T.ADMIN, 0);
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) { await require('../db').pool.end(); await db.drop(); }
  });

  async function req(method, url, { user, body, form } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = String(user);
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    else if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    const r = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, text, json, location: r.headers.get('location') };
  }
  const errOf = (loc) => new URLSearchParams((loc || '').split('?')[1] || '').get('err') || '';
  const page = async (url, user = T.ADMIN) => {
    const r = await req('GET', url, { user });
    assert.equal(r.status, 200, `${url}: ${r.text.slice(0, 400)}`);
    assert.ok(!r.text.includes('UNHANDLED'), r.text.slice(0, 400));
    return r.text;
  };
  const checkout = (body, user = T.CASHIER) => req('POST', '/pos/checkout', { user, body });
  const med = async (o = {}) => {
    const m = await T.addMedicine(db, { price: 100, cost: 40, ...o });
    await T.addBatch(db, m, 365, o.stock || 100, 40);
    if (o.controlled) await db.q('UPDATE medicines SET controlled_substance = true WHERE id = $1', [m]);
    return m;
  };
  const dbCust = (phone) => db.q1(`SELECT * FROM customers WHERE regexp_replace(phone, '\\D', '', 'g') = $1`, [phone.replace(/\D/g, '')]);

  describe('الكاشير: العملاء والآجل', () => {
    it('كتابة تليفون جديد بتسجّل العميل أوتوماتيك، والتليفون بصيغة تانية بيرجع لنفس العميل', async () => {
      const m = await med();
      const a = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_name: 'منى', customer_phone: '0100 123 4567' });
      assert.equal(a.status, 200, a.text);
      const c = await dbCust('01001234567');
      assert.equal(c.name, 'منى');
      const b = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_phone: '01001234567' });
      assert.equal(b.status, 200, b.text);
      assert.equal(Number((await db.q1('SELECT COUNT(*) AS n FROM customers WHERE phone IS NOT NULL')).n), 1);
      const inv = await db.q1('SELECT customer_id, customer_name FROM sale_invoices WHERE id = $1', [b.json.invoiceId]);
      assert.equal(inv.customer_id, c.id);
      assert.equal(inv.customer_name, 'منى', 'اسم العميل المسجّل بيتحط على الفاتورة');
    });

    it('اسم من غير تليفون: متسجّلش عميل (زي زمان)', async () => {
      const m = await med();
      const before = Number((await db.q1('SELECT COUNT(*) AS n FROM customers')).n);
      const r = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_name: 'زبون عابر' });
      assert.equal(r.status, 200);
      assert.equal(Number((await db.q1('SELECT COUNT(*) AS n FROM customers')).n), before);
    });

    it('بيع آجل: المدفوع دلوقتي في الخزنة والباقي على الحساب، والإيصال بيعرض الآجل', async () => {
      const m = await med();
      const cid = (await db.q1(`INSERT INTO customers (name, phone, credit_limit) VALUES ('آجل', '01111111111', 500) RETURNING id`)).id;
      const r = await checkout({ items: [{ medicine_id: m, quantity: 3 }], customer_id: cid, credit: true, paid_now: 100 });
      assert.equal(r.status, 200, r.text);
      const inv = await db.q1('SELECT total, credit_amount FROM sale_invoices WHERE id = $1', [r.json.invoiceId]);
      assert.equal(Number(inv.total), 300);
      assert.equal(Number(inv.credit_amount), 200);
      assert.equal(Number((await db.q1('SELECT balance FROM customers WHERE id = $1', [cid])).balance), 200);
      const cm = await db.q('SELECT amount FROM cash_movements WHERE invoice_id = $1', [r.json.invoiceId]);
      assert.deepEqual(cm.map((x) => Number(x.amount)), [100]);
      const html = await page(`/pos/receipt/${r.json.invoiceId}`, T.CASHIER);
      assert.ok(html.includes('آجل على الحساب'));
    });

    it('آجل بدون عميل / فوق الحد: 400 برسالة واضحة والمخزون ميتخصمش', async () => {
      const m = await med({ stock: 10 });
      const r1 = await checkout({ items: [{ medicine_id: m, quantity: 1 }], credit: true, paid_now: 0 });
      assert.equal(r1.status, 400);
      assert.ok(r1.json.error.includes('عميل'));
      const cid = (await db.q1(`INSERT INTO customers (name, phone, credit_limit) VALUES ('صغير', '01222222222', 50) RETURNING id`)).id;
      const r2 = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_id: cid, credit: true });
      assert.equal(r2.status, 200, 'مفيش حد آجل: البيع الآجل بيعدّي');
      assert.equal(await T.stock(db, m), 9);
    });

    it('عميل مدفوع بالكامل مع وضع الآجل: بيع عادي بدون دين', async () => {
      const m = await med();
      const cid = (await db.q1(`INSERT INTO customers (name, phone, credit_limit) VALUES ('دفع كامل', '01333333333', 500) RETURNING id`)).id;
      const r = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_id: cid, credit: true, paid_now: 100 });
      assert.equal(r.status, 200, r.text);
      assert.equal(Number((await db.q1('SELECT balance FROM customers WHERE id = $1', [cid])).balance), 0);
    });

    it('عميل موقوف أو غير موجود: يترفض', async () => {
      const m = await med();
      const r = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_id: 999999 });
      assert.equal(r.status, 400);
    });
  });

  describe('الأدوية الخاضعة للرقابة', () => {
    it('من غير بيانات أو برقم قومي غلط: يترفض والبيع يترجع', async () => {
      const m = await med({ controlled: true, stock: 20 });
      const items = [{ medicine_id: m, quantity: 1 }];
      const r1 = await checkout({ items });
      assert.equal(r1.status, 400);
      assert.ok(r1.json.error.includes('خاضع للرقابة'));
      const r2 = await checkout({ items, controlled: { patient_name: 'محمد علي', national_id: '123', prescription_no: 'R-1' } });
      assert.equal(r2.status, 400);
      const r3 = await checkout({ items, controlled: { patient_name: 'محمد علي', national_id: '29001011234567', prescription_no: '' } });
      assert.equal(r3.status, 400);
      assert.equal(await T.stock(db, m), 20);
      assert.equal(Number((await db.q1('SELECT COUNT(*) AS n FROM controlled_dispensing')).n), 0);
    });

    it('بيانات صحيحة: بيتسجّل في السجل مع الفاتورة، وبيظهر في الصفحة وملف CSV، وميتعدلش', async () => {
      const m = await med({ controlled: true, stock: 20, name: 'ترامادول-اختبار' });
      const normal = await med({ name: 'عادي' });
      const r = await checkout({
        items: [{ medicine_id: m, quantity: 2 }, { medicine_id: normal, quantity: 1 }],
        controlled: { patient_name: 'محمد علي', national_id: '29001011234567', prescription_no: 'RX-77', doctor_name: 'د. سمير' }
      });
      assert.equal(r.status, 200, r.text);
      const rows = await db.q('SELECT * FROM controlled_dispensing WHERE invoice_id = $1', [r.json.invoiceId]);
      assert.equal(rows.length, 1, 'الصنف الخاضع بس');
      assert.equal(rows[0].quantity_units, 2);
      assert.equal(rows[0].patient_name, 'محمد علي');
      await T.rejectsWith(assert, db.q('UPDATE controlled_dispensing SET patient_name = $1', ['x']), 'PH001');
      await T.rejectsWith(assert, db.q('DELETE FROM controlled_dispensing'), 'PH001');

      const html = await page('/controlled', T.PHARMA);
      assert.ok(html.includes('RX-77') && html.includes('29001011234567') && html.includes('ترامادول-اختبار'));
      const csv = await req('GET', '/controlled?format=csv', { user: T.ADMIN });
      assert.equal(csv.status, 200);
      assert.ok(csv.text.includes('RX-77'));
      // كاشير: ممنوع
      const denied = await req('GET', '/controlled', { user: T.CASHIER });
      assert.equal(denied.status, 403);
    });

    it('جواز سفر مقبول، وإلغاء الفاتورة بيفضّل السجل وبيعلّمه ملغاة', async () => {
      const m = await med({ controlled: true, stock: 20 });
      const r = await checkout({ items: [{ medicine_id: m, quantity: 1 }], controlled: { patient_name: 'John Smith', national_id: 'A1234567', prescription_no: 'P9' } });
      assert.equal(r.status, 200, r.text);
      await db.q(`SELECT void_sale_invoice($1, $2, 'admin', 'غلط', NULL)`, [r.json.invoiceId, T.ADMIN]);
      const html = await page('/controlled', T.ADMIN);
      assert.ok(html.includes('A1234567') && html.includes('ملغاة'));
    });
  });

  describe('صفحات العملاء', () => {
    it('القائمة والتفاصيل وكشف الحساب بترسم، والبحث للكاشير بيرجع العميل', async () => {
      const m = await med();
      const cid = (await db.q1(`INSERT INTO customers (name, phone, credit_limit) VALUES ('سارة أحمد', '01555555555', 1000) RETURNING id`)).id;
      await checkout({ items: [{ medicine_id: m, quantity: 2 }], customer_id: cid, credit: true, paid_now: 50 });
      const list = await page('/customers');
      assert.ok(list.includes('سارة أحمد'));
      assert.ok((await page('/customers?filter=debt&q=سارة')).includes('سارة أحمد'));
      const det = await page(`/customers/${cid}`);
      assert.ok(det.includes('دفتر الحساب') && det.includes('بيع آجل'));
      assert.ok((await page(`/customers/${cid}/statement`)).includes('كشف حساب'));
      const s = await req('GET', '/customers/search?q=0155', { user: T.CASHIER });
      assert.equal(s.json.results[0].name, 'سارة أحمد');
      assert.equal(s.json.results[0].available_credit, undefined, 'مفيش حد آجل');
      assert.equal((await req('GET', '/customers/search?q=س', { user: T.CASHIER })).json.results.length, 0, 'أقل من حرفين');
      assert.equal((await req('GET', '/customers/999999', { user: T.ADMIN })).status, 404);
    });

    it('السداد من الصفحة (مع مفتاح منع التكرار)، وتسوية الأدمن بس', async () => {
      const cid = (await db.q1(`INSERT INTO customers (name, phone, credit_limit, balance) VALUES ('سداد', '01666666666', 500, 0) RETURNING id`)).id;
      const m = await med();
      await checkout({ items: [{ medicine_id: m, quantity: 2 }], customer_id: cid, credit: true, paid_now: 0 });
      const pay = { amount: '120', method: 'cash', idempotency_key: 'route-pay-key-1' };
      const r1 = await req('POST', `/customers/${cid}/payment`, { user: T.CASHIER, form: pay });
      assert.equal(r1.status, 302);
      assert.ok(r1.location.includes('msg=paid'), r1.location);
      await req('POST', `/customers/${cid}/payment`, { user: T.CASHIER, form: pay });
      assert.equal(Number((await db.q1('SELECT balance FROM customers WHERE id = $1', [cid])).balance), 80);
      const over = await req('POST', `/customers/${cid}/payment`, { user: T.CASHIER, form: { amount: '999', method: 'cash' } });
      assert.ok(errOf(over.location).includes('أكبر من المديونية'), over.location);
      const denied = await req('POST', `/customers/${cid}/adjust`, { user: T.CASHIER, form: { amount: '10', reason: 'x', direction: 'decrease' } });
      assert.equal(denied.status, 403);
      const ok = await req('POST', `/customers/${cid}/adjust`, { user: T.ADMIN, form: { amount: '30', reason: 'إعفاء', direction: 'decrease' } });
      assert.ok(ok.location.includes('msg=adjusted'));
      assert.equal(Number((await db.q1('SELECT balance FROM customers WHERE id = $1', [cid])).balance), 50);
    });

    it('الكاشير مينفعش يوقف عميل، والأدمن يقدر', async () => {
      const r = await req('POST', '/customers', { user: T.CASHIER, form: { name: 'حاول', phone: '01077777777' } });
      assert.equal(r.status, 302);
      const c = await dbCust('01077777777');
      await req('POST', `/customers/${c.id}/update`, { user: T.CASHIER, form: { name: 'حاول', is_active: '' } });
      assert.equal((await db.q1('SELECT is_active FROM customers WHERE id = $1', [c.id])).is_active, true);
      await req('POST', `/customers/${c.id}/update`, { user: T.ADMIN, form: { name: 'حاول' } });
      assert.equal((await db.q1('SELECT is_active FROM customers WHERE id = $1', [c.id])).is_active, false);
    });

    it('تليفون مكرر أو غير صحيح عند الإضافة: رسالة خطأ', async () => {
      await req('POST', '/customers', { user: T.ADMIN, form: { name: 'أول', phone: '01088888888' } });
      const dup = await req('POST', '/customers', { user: T.ADMIN, form: { name: 'تاني', phone: '0108-888-8888' } });
      assert.ok(decodeURIComponent(dup.location).includes('مسجّل قبل كده'));
      const bad = await req('POST', '/customers', { user: T.ADMIN, form: { name: 'تالت', phone: '12' } });
      assert.ok(decodeURIComponent(bad.location).includes('11 رقم'));
    });
  });

  describe('تذكيرات الصرف', () => {
    it('تذكير متأخر بيظهر مع رابط واتساب، وصرف جديد بيصفّره، والتأجيل بيخفيه', async () => {
      const m = await med({ name: 'مزمن-ضغط' });
      const cid = (await db.q1(`INSERT INTO customers (name, phone) VALUES ('عم حسن', '01099999999') RETURNING id`)).id;
      const r = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_id: cid });
      await db.q(`UPDATE sale_invoices SET created_at = now() - interval '40 days' WHERE id = $1`, [r.json.invoiceId]);
      const add = await req('POST', `/customers/${cid}/refills`, { user: T.PHARMA, form: { medicine_id: String(m), interval_days: '30' } });
      assert.ok(add.location.includes('msg=refill_added'));
      let html = await page('/customers/refills');
      assert.ok(html.includes('مزمن-ضغط') && html.includes('متأخر 10 يوم'), html.slice(html.indexOf('المستحق'), 1500));
      assert.ok(html.includes('https://wa.me/201099999999'));
      const s = await req('GET', '/customers/search?q=حسن', { user: T.CASHIER });
      assert.equal(s.json.results[0].refills[0].name, 'مزمن-ضغط');

      const rid = (await db.q1('SELECT id FROM customer_refills WHERE customer_id = $1', [cid])).id;
      await req('POST', `/customers/refills/${rid}/snooze`, { user: T.PHARMA, form: { days: '3' } });
      html = await page('/customers/refills');
      assert.ok(!html.includes('مزمن-ضغط'), 'المؤجّل مبيظهرش');
      await db.q('UPDATE customer_refills SET snoozed_until = NULL WHERE id = $1', [rid]);
      await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_id: cid });   // صرف جديد النهارده
      const due = await db.q1('SELECT 1 AS x FROM customer_refills r WHERE r.id = $1', [rid]);
      assert.ok(due);
      html = await page('/customers/refills?days=0');
      assert.ok(!html.includes('متأخر 10 يوم'), 'الصرف الجديد صفّر العدّاد');
    });

    it('اقتراح ذكي: 3 مشتريات بفواصل 30 يوم ← يقترح تذكير كل 30 يوم، والتفعيل بيشيله من الاقتراحات', async () => {
      const m = await med({ name: 'مزمن-سكر' });
      const cid = (await db.q1(`INSERT INTO customers (name, phone) VALUES ('ست أم محمود', '01011112222') RETURNING id`)).id;
      for (const ago of [75, 45, 15]) {
        const r = await checkout({ items: [{ medicine_id: m, quantity: 1 }], customer_id: cid });
        await db.q(`UPDATE sale_invoices SET created_at = now() - $2::int * interval '1 day' WHERE id = $1`, [r.json.invoiceId, ago]);
      }
      const html = await page('/customers/refills');
      assert.ok(html.includes('مزمن-سكر') && html.includes('3 مرات') && html.includes('30 يوم'));
      const act = await req('POST', `/customers/${cid}/refills`, { user: T.PHARMA, form: { medicine_id: String(m), interval_days: '30', return_to: 'refills' } });
      assert.ok(act.location.startsWith('/customers/refills'));
      const html2 = await page('/customers/refills?days=60');
      assert.ok(!html2.includes('<th>اشترى</th>'), 'الاقتراح اتشال بعد التفعيل');
    });

    it('مدة غير صالحة أو صنف مش موجود: رسالة خطأ', async () => {
      const cid = (await db.q1(`INSERT INTO customers (name) VALUES ('بدون رقم') RETURNING id`)).id;
      const r = await req('POST', `/customers/${cid}/refills`, { user: T.PHARMA, form: { medicine_id: '1', interval_days: '2' } });
      assert.ok(errOf(r.location).includes('بين 5 و365'), r.location);
      const r2 = await req('POST', `/customers/${cid}/refills`, { user: T.PHARMA, form: { medicine_id: '999999', interval_days: '30' } });
      assert.ok(errOf(r2.location).includes('غير موجود'), r2.location);
    });
  });

  describe('الجرد', () => {
    it('دورة كاملة: بدء ← عدّ (يدوي وباركود) ← فروق ← اعتماد بيضبط المخزون ويسجّل التسويات، ولا يتكرر', async () => {
      const a = await med({ name: 'جرد-أ', stock: 50 });
      const b = await med({ name: 'جرد-ب', stock: 30 });
      const c = await med({ name: 'جرد-ج', stock: 10 });
      await db.q('UPDATE medicines SET barcode = $2 WHERE id = $1', [b, 'BC-JARD-B']);
      await db.q(`UPDATE medicines SET category = 'قسم-جرد' WHERE id = ANY($1::int[])`, [[a, b, c]]);

      const start = await req('POST', '/stocktake', { user: T.PHARMA, form: { name: 'جرد اختبار', category: 'قسم-جرد' } });
      assert.equal(start.status, 302);
      const id = parseInt(start.location.split('/').pop(), 10);
      const items = await db.q('SELECT medicine_id, system_units FROM stocktake_items WHERE stocktake_id = $1', [id]);
      assert.equal(items.length, 3);

      assert.equal((await req('POST', `/stocktake/${id}/count`, { user: T.PHARMA, body: { medicine_id: a, counted: 45 } })).status, 200);
      assert.equal((await req('POST', `/stocktake/${id}/count`, { user: T.PHARMA, body: { medicine_id: a, counted: -3 } })).status, 400);
      for (let i = 0; i < 3; i++) await req('POST', `/stocktake/${id}/scan`, { user: T.PHARMA, body: { barcode: 'BC-JARD-B' } });
      const miss = await req('POST', `/stocktake/${id}/scan`, { user: T.PHARMA, body: { barcode: 'NOPE' } });
      assert.equal(miss.status, 404);
      // ج: مش معدود

      const det = await page(`/stocktake/${id}?view=variance`, T.PHARMA);
      assert.ok(det.includes('جرد-أ') && det.includes('جرد-ب'));
      assert.ok((await page(`/stocktake/${id}`, T.PHARMA)).includes('جرد-ج'), 'لسه مش معدود');

      // الصيدلي مينفعش يعتمد
      assert.equal((await req('POST', `/stocktake/${id}/apply`, { user: T.PHARMA })).status, 403);
      const ap = await req('POST', `/stocktake/${id}/apply`, { user: T.ADMIN });
      assert.equal(ap.status, 302);
      assert.equal(await T.stock(db, a), 45);
      assert.equal(await T.stock(db, b), 3);
      assert.equal(await T.stock(db, c), 10, 'غير المعدود ميتلمسش');
      for (const m of [a, b, c]) await T.assertStockMatches(assert, db, m);
      const adj = await db.q(`SELECT difference FROM stock_adjustments WHERE reason LIKE 'جرد #%' ORDER BY difference`);
      assert.deepEqual(adj.map((x) => x.difference), [-27, -5]);
      assert.ok((await page(`/stocktake/${id}`, T.ADMIN)).includes('معتمد'));

      // اعتماد تاني + عدّ بعد الاعتماد: مرفوض
      const again = await req('POST', `/stocktake/${id}/apply`, { user: T.ADMIN });
      assert.ok(decodeURIComponent(again.location).includes('اتقفل'));
      assert.equal((await req('POST', `/stocktake/${id}/count`, { user: T.PHARMA, body: { medicine_id: a, counted: 1 } })).status, 409);
      assert.equal(await T.stock(db, a), 45);
    });

    it('زيادة في الجرد من غير تشغيلة صالحة: بتتسجّل "failed" وباقي الأصناف بتتعدل', async () => {
      const x = await T.addMedicine(db, { name: 'جرد-بلا-تشغيلة' });   // مفيش تشغيلات
      const y = await med({ name: 'جرد-عادي', stock: 20 });
      await db.q(`UPDATE medicines SET category = 'قسم-فشل' WHERE id = ANY($1::int[])`, [[x, y]]);
      const start = await req('POST', '/stocktake', { user: T.ADMIN, form: { category: 'قسم-فشل' } });
      const id = parseInt(start.location.split('/').pop(), 10);
      await req('POST', `/stocktake/${id}/count`, { user: T.ADMIN, body: { medicine_id: x, counted: 5 } });
      await req('POST', `/stocktake/${id}/count`, { user: T.ADMIN, body: { medicine_id: y, counted: 18 } });
      const ap = await req('POST', `/stocktake/${id}/apply`, { user: T.ADMIN });
      assert.equal(ap.status, 302);
      assert.equal(await T.stock(db, y), 18);
      assert.equal(await T.stock(db, x), 0);
      const row = await db.q1('SELECT apply_status FROM stocktake_items WHERE stocktake_id = $1 AND medicine_id = $2', [id, x]);
      assert.ok(row.apply_status.startsWith('failed'));
    });

    it('جرد بقسم فاضي، وصفحة القائمة، والكاشير ممنوع، والإلغاء', async () => {
      const r = await req('POST', '/stocktake', { user: T.ADMIN, form: { category: 'قسم-مش-موجود' } });
      assert.ok(decodeURIComponent(r.location).includes('مفيش أصناف'));
      assert.ok((await page('/stocktake')).includes('جرد اختبار'));
      assert.equal((await req('GET', '/stocktake', { user: T.CASHIER })).status, 403);
      const y = await med({ name: 'إلغاء-جرد' });
      await db.q(`UPDATE medicines SET category = 'قسم-إلغاء' WHERE id = $1`, [y]);
      const id = parseInt((await req('POST', '/stocktake', { user: T.ADMIN, form: { category: 'قسم-إلغاء' } })).location.split('/').pop(), 10);
      await req('POST', `/stocktake/${id}/cancel`, { user: T.ADMIN });
      assert.equal((await db.q1('SELECT status FROM stocktakes WHERE id = $1', [id])).status, 'cancelled');
      assert.equal((await req('POST', `/stocktake/${id}/count`, { user: T.ADMIN, body: { medicine_id: y, counted: 1 } })).status, 409);
    });
  });

  describe('النواقص الذكية', () => {
    it('منطق الاقتراح: سرعة البيع + مدة التوريد + تقريب للعلب', () => {
      const { suggest } = require('../routes/reorder');
      const base = { windowDays: 30, leadDays: 7, coverDays: 21, unitsPerBox: 10 };
      assert.equal(suggest({ ...base, sold: 0, sellable: 0, minStock: 10 }), null, 'مفيش طلب = مفيش اقتراح');
      assert.equal(suggest({ ...base, sold: 30, sellable: 500, minStock: 5 }), null, 'مخزون كفاية');
      const s = suggest({ ...base, sold: 60, sellable: 6, minStock: 5 });          // 2/يوم، يكفي 3 أيام
      assert.equal(Math.round(s.daysCover), 3);
      assert.equal(s.boxes, 4);                                                    // هدف 42، محتاج 36 ← 4 علب
      assert.equal(s.urgent, true);
      const z = suggest({ ...base, sold: 30, sellable: 0, minStock: 0 });
      assert.ok(z.urgent && z.boxes >= 1);
      const lowMin = suggest({ ...base, sold: 3, sellable: 8, minStock: 10 });      // بطيء بس تحت الحد
      assert.ok(lowMin && lowMin.boxes >= 1);
    });

    it('الصفحة: بتجمّع على آخر مورد بآخر سعر، وبتستبعد المنتهي من المتاح، ولا تقترح صنف مبيعش', async () => {
      const sup = (await db.q1(`INSERT INTO suppliers (name, phone) VALUES ('شركة الأمل', '01234567890') RETURNING id`)).id;
      const hot = await T.addMedicine(db, { name: 'ناقص-سريع', ups: 10, cost: 4 });
      const hb = await T.addBatch(db, hot, 200, 12, 4);
      const old = await T.addBatch(db, hot, 200, 50, 4);
      await T.expireBatch(db, old);                                                  // 50 منتهية ما تتحسبش
      const idle = await med({ name: 'مش-بيتباع', stock: 2 });
      for (let i = 0; i < 4; i++) await T.sell(db, { shift: cashierShift, items: [{ med: hot, qty: 3, price: 10 }] });
      await T.addBatch(db, hot, 200, 0 + 1, 4);                                      // تشغيلة صغيرة
      // آخر شراء من المورد (فاتورة شراء مباشرة)
      await db.q(`INSERT INTO purchase_invoices (supplier_id, status, total_amount) VALUES ($1, 'received', 40)`, [sup]);
      const piId = (await db.q1('SELECT max(id) AS id FROM purchase_invoices')).id;
      await db.q(`INSERT INTO purchase_invoice_items (invoice_id, medicine_id, batch_id, expiry_date, entry_unit, entry_quantity, entry_cost, quantity_units, cost_price_unit, line_total)
                  VALUES ($1, $2, $3, pharmacy_today() + 300, 'unit', 10, 4, 10, 4, 40)`, [piId, hot, hb]);
      const html = await page('/reorder?window=30&lead=7&cover=21', T.PHARMA);
      assert.ok(html.includes('ناقص-سريع'));
      assert.ok(html.includes('شركة الأمل'));
      assert.ok(html.includes('50 منتهي'));
      assert.ok(!html.includes('مش-بيتباع'));
      assert.equal((await req('GET', '/reorder', { user: T.CASHIER })).status, 403);
      void idle;
    });
  });

  describe('التحليلات', () => {
    it('الصفحة بترسم بكل اللوحات، وأدمن بس', async () => {
      const html = await page('/insights?days=90');
      for (const t of ['أوقات الزحمة', 'تحليل ABC', 'هامش الربح حسب القسم', 'مخزون راكد', 'تشغيلات معرّضة']) assert.ok(html.includes(t), t);
      assert.ok((await page('/insights?days=30')).includes('آخر 30 يوم'));
      assert.equal((await req('GET', '/insights', { user: T.PHARMA })).status, 403);
    });

    it('مخزون راكد وتشغيلة معرّضة بيطلعوا صح', async () => {
      const dead = await T.addMedicine(db, { name: 'راكد-جدًا', cost: 10 });
      await T.addBatch(db, dead, 300, 20, 10);
      const risky = await T.addMedicine(db, { name: 'معرّض-للانتهاء', cost: 10 });
      await T.addBatch(db, risky, 20, 100, 10);                                    // ينتهي بعد 20 يوم ومفيش بيع
      const html = await page('/insights');
      assert.ok(html.includes('راكد-جدًا'));
      assert.ok(html.includes('معرّض-للانتهاء'));
    });
  });

  describe('صفحات قديمة بعد التعديل', () => {
    it('المرتجع على فاتورة آجلة من صفحة المرتجعات + الإيصال + تفاصيل الفاتورة', async () => {
      const m = await med();
      const cid = (await db.q1(`INSERT INTO customers (name, phone, credit_limit) VALUES ('مرتجع-راوت', '01444444444', 1000) RETURNING id`)).id;
      const r = await checkout({ items: [{ medicine_id: m, quantity: 2 }], customer_id: cid, credit: true, paid_now: 0 });
      const it = (await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [r.json.invoiceId])).id;
      await db.q(`SELECT create_return($1, 1, 'x', true, 'cash', $2, 'admin')`, [it, T.ADMIN]);
      assert.equal(Number((await db.q1('SELECT balance FROM customers WHERE id = $1', [cid])).balance), 100);
      const detail = await page(`/sales/${r.json.invoiceId}`);
      assert.ok(detail.includes('آجل على العميل'));
      const retId = (await db.q1('SELECT id FROM returns ORDER BY id DESC LIMIT 1')).id;
      const rec = await req('GET', `/returns/${retId}/receipt`, { user: T.ADMIN });
      if (rec.status === 200) assert.ok(rec.text.includes('مديونية العميل'));
      assert.equal((await req('GET', '/pos', { user: T.CASHIER })).status, 200);
      assert.ok((await page('/pos', T.CASHIER)).includes('بيع آجل'));
      void adminShift;
    });
  });
});
