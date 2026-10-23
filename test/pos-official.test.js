// اختبارات: إضافة عميل سريعة من الكاشير، الأسعار الرسمية + سجل الأسعار، والفاتورة الحرارية.
const path = require('path');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const T = require('./helpers/db');

const USERS = { 1: { role: 'admin', username: 'admin' }, 2: { role: 'pharmacist', username: 'pharma' }, 3: { role: 'cashier', username: 'cashier' } };

describe('الكاشير: عميل جديد + أسعار رسمية + فاتورة حرارية', { skip: T.SKIP }, () => {
  let db; let server; let base; let shift;

  before(async () => {
    db = await T.createTestDb('posofficial');
    process.env.DATABASE_URL = db.url;
    await db.q(`CREATE TABLE IF NOT EXISTS drug_reference (id SERIAL PRIMARY KEY, name_en TEXT NOT NULL, name_ar TEXT, scientific_name TEXT, manufacturer TEXT, drug_class TEXT, route TEXT, price_egp NUMERIC(12,2), barcode TEXT)`);
    await db.q(`CREATE TABLE IF NOT EXISTS employees (id SERIAL PRIMARY KEY, name TEXT, is_active BOOLEAN DEFAULT true)`); // جدول الرواتب بيتعمل يدويًا في Supabase
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
    app.use('/customers', require('../routes/customers'));
    app.use('/settings', require('../routes/settings'));
    app.use('/official-prices', require('../routes/official-prices'));
    app.use('/products', require('../routes/products'));
    app.use((err, req, res, next) => { res.status(500).send('UNHANDLED: ' + (err && err.stack)); }); // eslint-disable-line no-unused-vars
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    shift = await T.openShift(db, T.CASHIER, 0);
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) { await require('../db').pool.end(); await db.drop(); }
  });

  const call = async (method, url, { user = 1, body, form } = {}) => {
    const headers = { 'x-test-user': String(user) };
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    else if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* html */ }
    return { status: res.status, text, json, location: res.headers.get('location') };
  };

  it('عميل جديد من الكاشير: يتسجّل، والتليفون المكرر يرجّع الموجود', async () => {
    const a = await call('POST', '/customers/quick', { user: 3, body: { name: 'سعيد', phone: '01012345678' } });
    assert.equal(a.status, 200);
    assert.equal(a.json.existing, false);
    assert.equal(a.json.customer.credit_limit, undefined, 'مفيش حد آجل');
    assert.equal(a.json.customer.balance, 0);
    const b = await call('POST', '/customers/quick', { user: 3, body: { name: 'اسم تاني', phone: '0101 234 5678' } });
    assert.equal(b.json.existing, true);
    assert.equal(b.json.customer.id, a.json.customer.id);
    const bad = await call('POST', '/customers/quick', { user: 3, body: { name: '', phone: '' } });
    assert.equal(bad.status, 400);
    const badPhone = await call('POST', '/customers/quick', { user: 3, body: { name: 'x', phone: '123' } });
    assert.equal(badPhone.status, 400);
  });

  it('البحث في الكاشير بيرجّع المديونية (عليه فلوس / لا)', async () => {
    const s = await call('GET', '/customers/search?q=' + encodeURIComponent('سعيد'), { user: 3 });
    assert.equal(s.json.results.length, 1);
    assert.equal(Number(s.json.results[0].balance), 0);
    const p = await call('GET', '/customers/search?q=0101234', { user: 3 });
    assert.equal(p.json.results[0].name, 'سعيد');
  });

  it('صفحة الكاشير فيها نوع البيع وإضافة عميل جديد', async () => {
    const r = await call('GET', '/pos', { user: 3 });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('بيع آجل / تقسيط'));
    assert.ok(r.text.includes('عميل جديد'));
    assert.ok(r.text.includes('creditSearch'));
  });

  it('الأسعار الرسمية: تقارن، وتطبّق على المحدد، وتسجّل في السجل، والكاشير ممنوع', async () => {
    const ref = await db.q1(`INSERT INTO drug_reference (name_en, price_egp) VALUES ('Offi 30 tabs', 45) RETURNING id`);
    const med = await T.addMedicine(db, { name: 'Offi 30 tabs', ups: 10, spb: 3, price: 2, priceStrip: 20, priceBox: 60, cost: 1 });
    await db.q('UPDATE medicines SET ref_id = $1 WHERE id = $2', [ref.id, med]);
    const ok = await db.q1(`INSERT INTO drug_reference (name_en, price_egp) VALUES ('Same price', 30) RETURNING id`);
    const med2 = await T.addMedicine(db, { name: 'Same price', ups: 1, spb: 1, price: 30, priceBox: 30 });
    await db.q('UPDATE medicines SET ref_id = $1 WHERE id = $2', [ok.id, med2]);

    const page = await call('GET', '/official-prices', { user: 2 });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Offi 30 tabs'));
    assert.ok(!page.text.includes('Same price</strong>'), 'المطابق مبيظهرش في عرض المختلف');
    assert.equal((await call('GET', '/official-prices', { user: 3 })).status !== 200, true, 'الكاشير ممنوع');

    const denied = await call('POST', '/official-prices/apply', { user: 2, form: { all: '1' } });
    assert.equal(denied.status, 302);
    assert.equal(Number((await db.q1('SELECT sale_price_box FROM medicines WHERE id = $1', [med])).sale_price_box), 60, 'الصيدلي مايقدرش يطبّق');

    const res = await call('POST', '/official-prices/apply', { user: 1, form: { ids: String(med) } });
    assert.equal(res.status, 302);
    const m = await db.q1('SELECT sale_price_unit, sale_price_strip, sale_price_box FROM medicines WHERE id = $1', [med]);
    assert.deepEqual([Number(m.sale_price_unit), Number(m.sale_price_strip), Number(m.sale_price_box)], [1.5, 15, 45]);
    const same = await db.q1('SELECT sale_price_box FROM medicines WHERE id = $1', [med2]);
    assert.equal(Number(same.sale_price_box), 30);

    const h = await db.q('SELECT source, old_box, new_box, changed_by FROM price_history WHERE medicine_id = $1', [med]);
    assert.equal(h.length, 1);
    assert.equal(h[0].source, 'official');
    assert.equal(Number(h[0].old_box), 60); assert.equal(Number(h[0].new_box), 45); assert.equal(h[0].changed_by, 1);

    const hist = await call('GET', '/official-prices/history', { user: 1 });
    assert.equal(hist.status, 200);
    assert.ok(hist.text.includes('Offi 30 tabs'));
    // بعد التطبيق: مفيش مختلفين
    const after2 = await call('GET', '/official-prices', { user: 1 });
    assert.ok(after2.text.includes('مطابقة للسعر الرسمي'));
  });

  it('تعديل السعر يدويًا بيتسجّل (مصدر يدوي + المستخدم)، وتطبيق على الكل شغال', async () => {
    const ref = await db.q1(`INSERT INTO drug_reference (name_en, price_egp) VALUES ('Manual one', 100) RETURNING id`);
    const med = await T.addMedicine(db, { name: 'Manual one', price: 100, priceBox: 100 });
    await db.q('UPDATE medicines SET ref_id = $1 WHERE id = $2', [ref.id, med]);
    await db.q(`UPDATE medicines SET sale_price_unit = 120, sale_price_box = 120 WHERE id = $1`, [med]);
    const h = await db.q('SELECT source FROM price_history WHERE medicine_id = $1', [med]);
    assert.equal(h[0].source, 'manual');
    await call('POST', '/official-prices/apply', { user: 1, form: { all: '1' } });
    assert.equal(Number((await db.q1('SELECT sale_price_box FROM medicines WHERE id = $1', [med])).sale_price_box), 100);
  });

  it('ربط تلقائي بالاسم', async () => {
    await db.q(`INSERT INTO drug_reference (name_en, price_egp) VALUES ('Auto Link Med', 12)`);
    const med = await T.addMedicine(db, { name: 'auto link med', price: 10 });
    const r = await call('POST', '/official-prices/link-by-name', { user: 1 });
    assert.equal(r.status, 302);
    assert.ok((await db.q1('SELECT ref_id FROM medicines WHERE id = $1', [med])).ref_id);
  });

  it('الكاشير يشوف السعر الرسمي في نتايج البحث', async () => {
    const r = await call('GET', '/pos/search?q=Offi', { user: 3 });
    const m = r.json.results.find((x) => x.name === 'Offi 30 tabs');
    assert.equal(m.official_box, 45);
  });

  it('الفاتورة: حراري 80/58 و A4 وإعدادات الطباعة', async () => {
    const med = await T.addMedicine(db, { name: 'Print med', price: 10 });
    await T.addBatch(db, med, 365, 50, 5);
    const inv = await T.sell(db, { shift, items: [{ med, qty: 2, price: 10 }] });
    const t80 = await call('GET', `/pos/receipt/${inv.id}`, { user: 3 });
    assert.ok(t80.text.includes('class="thermal"'));
    assert.ok(t80.text.includes('size: 80mm auto'));
    const t58 = await call('GET', `/pos/receipt/${inv.id}?paper=58`, { user: 3 });
    assert.ok(t58.text.includes('size: 58mm auto'));
    const a4 = await call('GET', `/pos/receipt/${inv.id}?paper=a4`, { user: 3 });
    assert.ok(a4.text.includes('receipt-card') && !a4.text.includes('class="thermal"'));
    assert.ok(!t80.text.includes('setTimeout(function () { window.print(); }'), 'مفيش طباعة تلقائية افتراضيًا');

    await call('POST', '/settings/print', { user: 1, form: { receipt_paper: '58', receipt_auto_print: 'on', receipt_footer: 'مع السلامة' } });
    const s = await call('GET', `/pos/receipt/${inv.id}`, { user: 3 });
    assert.ok(s.text.includes('size: 58mm auto'));
    assert.ok(s.text.includes('مع السلامة'));
    assert.ok(s.text.includes('setTimeout(function () { window.print(); }'));
    const settingsPage = await call('GET', '/settings', { user: 1 });
    assert.equal(settingsPage.status, 200);
    assert.ok(settingsPage.text.includes('طباعة الفاتورة'));
  });
});
