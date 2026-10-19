// اختبارات routes المشتريات (الصلاحيات + إنشاء + دفع + إلغاء)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('routes المشتريات', { skip: T.SKIP }, () => {
  let db; let app; let sup; let med;

  before(async () => {
    db = await T.createTestDb('purchr');
    process.env.DATABASE_URL = db.url;
    const { startApp } = require('./helpers/app');
    app = await startApp({ '/purchases': require('../routes/purchases'), '/suppliers': require('../routes/suppliers') });
    sup = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد') RETURNING id`)).id;
    med = await T.addMedicine(db, { ups: 10, spb: 2 });
  });
  after(async () => { if (app) await app.close(); if (db) { await require('../db').pool.end(); await db.drop(); } });

  const item = (o = {}) => ({ medicine_id: med, unit: 'box', quantity: 2, cost: 40, expiry_date: '2099-01-01', batch_number: 'B1', ...o });
  const create = (user, over = {}, items = [item()]) =>
    app.request('POST', '/purchases/create', { user, form: { supplier_id: String(sup), items_json: JSON.stringify(items), paid_amount: '0', method: 'cash', ...over } });

  it('الكاشير ممنوع، وغير المسجل يتحول للدخول', async () => {
    assert.equal((await app.request('GET', '/purchases', { user: T.CASHIER })).status, 403);
    assert.equal((await create(T.CASHIER)).status, 403);
    assert.equal((await app.request('GET', '/purchases')).status, 302);
  });

  it('الصيدلي يسجل فاتورة ويشوفها، لكن مش يدفع ولا يلغي', async () => {
    const r = await create(T.PHARMA, { invoice_number: 'P-1' });
    assert.equal(r.status, 302, r.text);
    const id = Number(r.location.split('/').pop());
    const inv = await db.q1('SELECT * FROM purchase_invoices WHERE id = $1', [id]);
    assert.equal(Number(inv.total_amount), 80);
    assert.equal(inv.created_by, T.PHARMA);
    assert.equal((await db.q1('SELECT stock_units FROM medicines WHERE id = $1', [med])).stock_units, 40);
    const page = await app.request('GET', `/purchases/${id}`, { user: T.PHARMA });
    assert.equal(page.json.__view, 'purchase-detail');
    assert.equal(page.json.items.length, 1);
    assert.equal((await app.request('POST', `/purchases/${id}/pay`, { user: T.PHARMA, form: { amount: '10' } })).status, 403);
    assert.equal((await app.request('POST', `/purchases/${id}/cancel`, { user: T.PHARMA, form: { reason: 'x' } })).status, 403);
  });

  it('خطأ في التحقق: بيرجع نفس الصفحة بالرسالة ومن غير ما يسجل حاجة', async () => {
    const before = (await db.q1('SELECT COUNT(*)::int AS c FROM purchase_invoices')).c;
    const r = await create(T.ADMIN, {}, [item({ expiry_date: '2000-01-01' })]);
    assert.equal(r.status, 400);
    assert.equal(r.json.__view, 'purchase-new');
    assert.match(r.json.error, /الصلاحية/);
    const bad = await create(T.ADMIN, {}, [item({ quantity: 'abc' })]);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /الكمية/);
    assert.equal((await create(T.ADMIN, { supplier_id: '' })).status, 400);
    assert.equal((await create(T.ADMIN, { items_json: 'not json' })).status, 400);
    assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM purchase_invoices')).c, before);
  });

  it('دبل كليك بنفس مفتاح منع التكرار: نفس الفاتورة، مفيش تكرار', async () => {
    const before = (await db.q1('SELECT COUNT(*)::int AS c FROM purchase_invoices')).c;
    const a = await create(T.ADMIN, { idempotency_key: 'route-key-0001' });
    const b = await create(T.ADMIN, { idempotency_key: 'route-key-0001' });
    assert.equal(a.status, 302);
    assert.equal(b.status, 302);
    assert.equal(a.location, b.location);
    assert.equal((await db.q1('SELECT COUNT(*)::int AS c FROM purchase_invoices')).c, before + 1);
  });

  it('الأدمن يدفع (وبيتمنع الزيادة) ويلغي بسبب', async () => {
    const r = await create(T.ADMIN, { paid_amount: '30' });
    const id = Number(r.location.split('/').pop());
    const ok = await app.request('POST', `/purchases/${id}/pay`, { user: T.ADMIN, form: { amount: '50', method: 'bank' } });
    assert.match(decodeURIComponent(ok.location), /ok=تم تسجيل الدفعة/);
    const over = await app.request('POST', `/purchases/${id}/pay`, { user: T.ADMIN, form: { amount: '1' } });
    assert.match(decodeURIComponent(over.location), /error=المبلغ أكبر من المتبقي/);
    assert.equal(Number((await db.q1('SELECT paid_amount FROM purchase_invoices WHERE id = $1', [id])).paid_amount), 80);

    const r2 = await create(T.ADMIN);
    const id2 = Number(r2.location.split('/').pop());
    const noReason = await app.request('POST', `/purchases/${id2}/cancel`, { user: T.ADMIN, form: { reason: '' } });
    assert.match(decodeURIComponent(noReason.location), /error=سبب الإلغاء/);
    const stockBefore = (await db.q1('SELECT stock_units FROM medicines WHERE id = $1', [med])).stock_units;
    await app.request('POST', `/purchases/${id2}/cancel`, { user: T.ADMIN, form: { reason: 'غلط' } });
    assert.equal((await db.q1('SELECT stock_units FROM medicines WHERE id = $1', [med])).stock_units, stockBefore - 40);
  });

  it('دفعة على حساب المورد من صفحة المورد، وصفحة المورد بتعرض الرصيد', async () => {
    const s = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد 2') RETURNING id`)).id;
    await app.request('POST', '/purchases/create', { user: T.ADMIN, form: { supplier_id: String(s), items_json: JSON.stringify([item()]) } });
    const page = await app.request('GET', `/suppliers/${s}`, { user: T.ADMIN });
    assert.equal(page.json.__view, 'supplier-detail');
    assert.equal(Number(page.json.balance.balance_due), 80);
    const p = await app.request('POST', `/suppliers/${s}/pay`, { user: T.ADMIN, form: { amount: '80' } });
    assert.match(decodeURIComponent(p.location), /ok=/);
    const page2 = await app.request('GET', `/suppliers/${s}`, { user: T.ADMIN });
    assert.equal(Number(page2.json.balance.balance_due), 0);
    const bad = await app.request('POST', `/suppliers/${s}/pay`, { user: T.ADMIN, form: { amount: '5' } });
    assert.match(decodeURIComponent(bad.location), /error=المبلغ أكبر من إجمالي المستحق/);
    const del = await app.request('POST', `/suppliers/${s}/delete`, { user: T.ADMIN });
    assert.equal(del.status, 409, del.text);
  });
});
