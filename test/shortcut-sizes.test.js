// اختبارات: آخر سعر شراء، كلمة اختصار الصنف، مقاسات الأصناف، واختصارات الأسهم
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('كلمة الاختصار + المقاسات + آخر سعر شراء', { skip: T.SKIP }, () => {
  let db; let app; let sup;

  before(async () => {
    db = await T.createTestDb('shortsz');
    process.env.DATABASE_URL = db.url;
    const { startApp } = require('./helpers/app');
    app = await startApp({ '/purchases': require('../routes/purchases'), '/pos': require('../routes/pos'), '/products': require('../routes/products') });
    sup = (await db.q1(`INSERT INTO suppliers (name) VALUES ('مورد') RETURNING id`)).id;
  });
  after(async () => { if (app) await app.close(); if (db) { await require('../db').pool.end(); await db.drop(); } });

  it('آخر سعر شراء: بيرجع لكل صنف بسعر الحبة قبل الخصم، وأول مرة = متوسط التكلفة أو null', async () => {
    const med = await T.addMedicine(db, { name: 'lastcost-a', ups: 10, spb: 2, cost: 0 });
    let r = await app.request('GET', '/purchases/api/medicines?q=lastcost-a', { user: T.PHARMA });
    assert.equal(r.json.results[0].last_cost, null);

    const item = (cost, disc = 0) => ({ medicine_id: med, unit: 'box', quantity: 2, cost, discount_percent: disc, expiry_date: '2099-01-01', batch_number: 'B' });
    const mk = (cost, disc) => app.request('POST', '/purchases/create', { user: T.ADMIN, form: { supplier_id: String(sup), items_json: JSON.stringify([item(cost, disc)]), method: 'cash' } });
    assert.equal((await mk(40, 10)).status, 302);
    r = await app.request('GET', '/purchases/api/medicines?q=lastcost-a', { user: T.PHARMA });
    const lc = r.json.results[0].last_cost;
    assert.equal(lc.source, 'invoice');
    assert.equal(lc.unit_cost, 2);            // العلبة 40 = 20 حبة ← 2 للحبة
    assert.equal(lc.discount_percent, 10);
    assert.equal(lc.supplier, 'مورد');
    const box = r.json.results[0].levels.find((l) => l.key === 'box');
    assert.equal(lc.unit_cost * box.qty, 40);

    // فاتورة أحدث بسعر مختلف تبقى هي آخر سعر؛ والملغاة متتحسبش
    assert.equal((await mk(50, 0)).status, 302);
    r = await app.request('GET', '/purchases/api/medicines?q=lastcost-a', { user: T.PHARMA });
    assert.equal(r.json.results[0].last_cost.unit_cost, 2.5);
    const last = await db.q1('SELECT id FROM purchase_invoices ORDER BY id DESC LIMIT 1');
    await db.q(`UPDATE purchase_invoices SET status = 'cancelled' WHERE id = $1`, [last.id]);
    r = await app.request('GET', '/purchases/api/medicines?q=lastcost-a', { user: T.PHARMA });
    assert.equal(r.json.results[0].last_cost.unit_cost, 2);
  });

  it('صنف مفيش له فواتير شراء: بيرجع متوسط التكلفة المسجّل (source=avg)', async () => {
    await T.addMedicine(db, { name: 'avgcost-b', ups: 1, spb: 1, cost: 7.5 });
    const r = await app.request('GET', '/purchases/api/medicines?q=avgcost-b', { user: T.PHARMA });
    assert.equal(r.json.results[0].last_cost.source, 'avg');
    assert.equal(r.json.results[0].last_cost.unit_cost, 7.5);
  });

  it('إضافة صنف جديد من صفحة التشغيلات بكلمة اختصار، والتكرار مرفوض بدون حساسية لحالة الحروف', async () => {
    const add = (name, sc) => app.request('POST', '/purchases/api/medicines/add', { user: T.PHARMA, body: { name, form_kind: 'tablet', barcode: '', shortcut_code: sc } });
    const a = await add('منتج اختصار 1', 'Pan');
    assert.equal(a.status, 200, a.text);
    assert.equal((await db.q1('SELECT shortcut_code FROM medicines WHERE id = $1', [a.json.medicine.id])).shortcut_code, 'Pan');
    const dup = await add('منتج اختصار 2', 'pan');
    assert.equal(dup.status, 409);
    assert.match(dup.json.error, /الاختصار/);
    assert.equal((await add('منتج اختصار 3', 'two words')).status, 400);
    assert.equal((await add('منتج بدون اختصار', '')).status, 200);
  });

  it('الكاشير: الاختصار بيلاقي الصنف (lookup?alias=1) وبيتقدّم في البحث، والباركود زي ما هو', async () => {
    const id = (await db.q1(`INSERT INTO medicines (name, sale_price_unit, stock_units, shortcut_code, barcode) VALUES ('بنادول اكسترا', 5, 0, 'bx', '6221234567890') RETURNING id`)).id;
    await T.addBatch(db, id, 400, 20);
    let r = await app.request('GET', '/pos/lookup?alias=1&barcode=BX', { user: T.CASHIER });
    assert.equal(r.json.found, true);
    assert.equal(r.json.medicine.id, id);
    r = await app.request('GET', '/pos/lookup?barcode=bx', { user: T.CASHIER });   // من غير alias=1 مش بيدوّر في الاختصارات
    assert.equal(r.json.found, false);
    r = await app.request('GET', '/pos/lookup?barcode=6221234567890', { user: T.CASHIER });
    assert.equal(r.json.found, true);
    r = await app.request('GET', '/pos/search?q=bx', { user: T.CASHIER });
    assert.equal(r.json.results[0].id, id);
    // صنف موقوف مايتضافش
    await db.q('UPDATE medicines SET is_active = false WHERE id = $1', [id]);
    r = await app.request('GET', '/pos/lookup?alias=1&barcode=bx', { user: T.CASHIER });
    assert.equal(r.json.found, false);
  });

  it('المقاسات: /pos/sizes بترجّع نفس المجموعة مترتبة (الأصغر الأول) مع المخزون الصالح بس', async () => {
    const mk = async (name, label, ord, group = 'سرنجات') =>
      (await db.q1(`INSERT INTO medicines (name, sale_price_unit, stock_units, size_group, size_label, size_order) VALUES ($1, 3, 0, $2, $3, $4) RETURNING id`, [name, group, label, ord])).id;
    const s10 = await mk('سرنجة 10', '10 مل', 3);
    const s2 = await mk('سرنجة 2', '2 مل', 1);
    const s5 = await mk('سرنجة 5', '5 مل', 2, 'سرنجات');   // نفس المجموعة
    await mk('حفاظة L', 'L', 1, 'حفاظات');                  // مجموعة تانية
    await T.addBatch(db, s2, 300, 10);
    await T.addBatch(db, s10, 300, 4);
    const r = await app.request('GET', `/pos/sizes?id=${s5}`, { user: T.CASHIER });
    assert.deepEqual(r.json.results.map((m) => m.size_label), ['2 مل', '5 مل', '10 مل']);
    assert.deepEqual(r.json.results.map((m) => m.stock_units), [10, 0, 4]);   // 5 مل مفيهوش مخزون
    const none = await T.addMedicine(db, { name: 'no-sizes' });
    assert.deepEqual((await app.request('GET', `/pos/sizes?id=${none}`, { user: T.CASHIER })).json.results, []);
  });

  it('إضافة/تعديل صنف من صفحة الأصناف بيحفظ الاختصار والمقاس، وبيمسح المقاس لو المجموعة فاضية', async () => {
    const r = await app.request('POST', '/products/add', { user: T.ADMIN, form: { name: 'سرنجة 20', sale_price_unit: '4', form_kind: 'injection', shortcut_code: 'syr20', size_group: 'سرنجات', size_label: '20 مل', size_order: '4' } });
    assert.equal(r.status, 302, r.text);
    const m = await db.q1(`SELECT * FROM medicines WHERE name = 'سرنجة 20'`);
    assert.equal(m.shortcut_code, 'syr20');
    assert.equal(m.size_group, 'سرنجات');
    assert.equal(Number(m.size_order), 4);
    const base = { name: 'سرنجة 20', sale_price_unit: '4', form_kind: 'injection' };
    assert.equal((await app.request('POST', `/products/${m.id}/update`, { user: T.ADMIN, form: { ...base, shortcut_code: 'syr20', size_group: '', size_label: 'x', size_order: '9' } })).status, 302);
    const m2 = await db.q1('SELECT * FROM medicines WHERE id = $1', [m.id]);
    assert.equal(m2.size_group, null); assert.equal(m2.size_label, null); assert.equal(m2.size_order, null);
    // اختصار مكرر في صنف تاني → رسالة واضحة
    const other = await app.request('POST', '/products/add', { user: T.ADMIN, form: { ...base, name: 'تاني', shortcut_code: 'SYR20' } });
    assert.match(other.json.error, /الاختصار/);
    // اختصار فيه مسافة → مرفوض
    const sp = await app.request('POST', '/products/add', { user: T.ADMIN, form: { ...base, name: 'تالت', shortcut_code: 'a b' } });
    assert.equal(sp.status, 400);
  });
});

describe('اختصارات الأسهم الافتراضية', () => {
  it('→ ← للكمية و↑ ↓ للمقاس، وكلهم مختلفين', () => {
    const { DEFAULTS } = require('../lib/shortcuts');
    assert.equal(DEFAULTS.pos_qty_up, 'ArrowRight');
    assert.equal(DEFAULTS.pos_qty_down, 'ArrowLeft');
    assert.equal(DEFAULTS.pos_size_up, 'ArrowUp');
    assert.equal(DEFAULTS.pos_size_down, 'ArrowDown');
    const vals = Object.values(DEFAULTS).filter(Boolean);
    assert.equal(new Set(vals).size, vals.length);
  });
});
