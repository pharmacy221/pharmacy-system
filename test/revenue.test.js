// اختبارات الإيرادات والتقارير: دوال report_* + تطابق Dashboard مع التقارير (عبر الـ routes الحقيقية)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers/db');

describe('الإيرادات والتقارير', { skip: T.SKIP }, () => {
  let db; let app; let shift; let adminShift; let A; let B; let C; let inv1; let inv2; let inv3;
  const today = () => db.q1(`SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS d`).then((r) => r.d);
  const summary = (from, to) => db.q1('SELECT * FROM report_sales_summary($1::date, $2::date)', [from, to]);

  before(async () => {
    db = await T.createTestDb('revenue');
    process.env.DATABASE_URL = db.url;
    const { startApp } = require('./helpers/app');
    app = await startApp({
      '/dashboard': require('../routes/dashboard'),
      '/reports': require('../routes/reports')
    });
    shift = await T.openShift(db, T.CASHIER);
    adminShift = await T.openShift(db, T.ADMIN);
    A = await T.addMedicine(db, { name: 'A', price: 10 }); await T.addBatch(db, A, 200, 100, 4);
    B = await T.addMedicine(db, { name: 'B', price: 20 }); await T.addBatch(db, B, 200, 100, 8);
    C = await T.addMedicine(db, { name: 'C', price: 5 }); await T.addBatch(db, C, 200, 100, 2);
  });
  after(async () => { if (app) await app.close(); if (db) { const { pool } = require('../db'); await pool.end(); await db.drop(); } });

  it('صنف واحد، ثم 3 أصناف بخصم، ثم فاتورة ملغاة: gross/net/profit صح', async () => {
    const d = await today();

    inv1 = await T.sell(db, { shift, items: [{ med: A, qty: 3, price: 10 }] });
    let s = await summary(d, d);
    assert.equal(Number(s.gross_sales), 30);
    assert.equal(Number(s.net_sales), 30);
    assert.equal(Number(s.net_profit), 18, '30 − تكلفة 12');
    assert.equal(Number(s.invoice_count), 1);

    inv2 = await T.sell(db, { shift, items: [{ med: A, qty: 1, price: 10 }, { med: B, qty: 2, price: 20 }, { med: C, qty: 4, price: 5 }], discount: 7 });
    assert.equal(inv2.total, 63);
    s = await summary(d, d);
    assert.equal(Number(s.gross_sales), 93, 'مفيش تكرار JOIN: كل فاتورة بتتحسب مرة');
    assert.equal(Number(s.invoice_count), 2);
    assert.equal(Number(s.net_profit), 18 + (63 - 28));

    inv3 = await T.sell(db, { shift, items: [{ med: B, qty: 1, price: 20 }] });
    await db.q1('SELECT void_sale_invoice($1,$2,$3,$4,$5)', [inv3.id, T.ADMIN, 'admin', 'تجربة', null]);
    s = await summary(d, d);
    assert.equal(Number(s.gross_sales), 93, 'الملغاة بره الحساب');
    assert.equal(Number(s.invoice_count), 2);
  });

  it('مرتجع جزئي: net = gross − المرتجعات والربح يتعدّل بالتكلفة المسترجعة', async () => {
    const d = await today();
    const item = await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [inv1.id]);
    await db.q1('SELECT create_return($1,1,$2,true,NULL,$3,$4,NULL)', [item.id, 'سبب', T.ADMIN, 'admin']);   // مرتجع 10 ج
    const s = await summary(d, d);
    assert.equal(Number(s.gross_sales), 93);
    assert.equal(Number(s.returns_total), 10);
    assert.equal(Number(s.net_sales), 83);
    assert.equal(Number(s.net_profit), 47, '18 + 35 − (10 − تكلفة 4)');
    assert.equal(Number(s.returns_count), 1);
  });

  it('مرتجعات الفاتورة الملغاة مبتتحسبش (الفاتورة وكل مرتجعاتها بره)', async () => {
    const d = await today();
    const x = await T.sell(db, { shift, items: [{ med: C, qty: 10, price: 5 }] });
    const item = await db.q1('SELECT id FROM sale_items WHERE invoice_id = $1', [x.id]);
    await db.q1('SELECT create_return($1,2,$2,true,NULL,$3,$4,NULL)', [item.id, 'سبب', T.ADMIN, 'admin']);
    await db.q1('SELECT void_sale_invoice($1,$2,$3,$4,$5)', [x.id, T.ADMIN, 'admin', 'تجربة', null]);
    const s = await summary(d, d);
    assert.equal(Number(s.net_sales), 83);
    assert.equal(Number(s.returns_total), 10);
  });

  it('أكثر الأصناف مبيعًا: وحدات وإيراد بعد المرتجع والخصم، ومجموع الإيراد = net_sales', async () => {
    const d = await today();
    const rows = await db.q('SELECT * FROM report_top_medicines($1::date, $2::date, 10)', [d, d]);
    const by = Object.fromEntries(rows.map((r) => [r.name, [Number(r.units_sold), Number(r.revenue)]]));
    assert.deepEqual(by.A, [3, 29]);   // 3+1−1 وحدة | 30 + 9 − 10
    assert.deepEqual(by.B, [2, 36]);
    assert.deepEqual(by.C, [4, 18]);
    assert.equal(rows.reduce((a, r) => a + Number(r.revenue), 0), 83);
    assert.equal(rows[0].name, 'C', 'الترتيب بالوحدات المباعة');
  });

  it('Dashboard و Reports (عبر الـ routes الحقيقية) بيرجعوا نفس الأرقام', async () => {
    const dash = await app.request('GET', '/dashboard', { user: T.ADMIN });
    assert.equal(dash.status, 200, dash.text);
    assert.deepEqual([dash.json.today.revenue, dash.json.today.profit, dash.json.today.count], [83, 47, 2]);
    assert.equal(dash.json.month.revenue, 83);
    assert.ok(dash.json.recentInvoices.every((i) => i.status === 'completed'), 'الداشبورد مبتعرضش الملغاة');

    const rep = await app.request('GET', '/reports', { user: T.ADMIN });
    assert.equal(rep.status, 200, rep.text);
    for (const k of ['todaySummary', 'weekSummary', 'monthSummary', 'rangeSummary']) {
      assert.deepEqual([rep.json[k].revenue, rep.json[k].profit, rep.json[k].count], [83, 47, 2], k);
    }
    assert.equal(rep.json.dailySeries.length, 1);
    assert.equal(rep.json.dailySeries[0].revenue, 83);
    assert.match(rep.json.dailySeries[0].day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rep.json.topMedicines.reduce((a, r) => a + r.revenue, 0), 83);
  });

  it('فواتير الساعة 00:30 بتوقيت القاهرة تتحسب في "النهارده" (مش في اليوم السابق بتوقيت UTC)', async () => {
    const d = await today();
    const x = await T.sell(db, { shift, items: [{ med: C, qty: 1, price: 5 }] });
    await db.q('UPDATE sale_invoices SET created_at = ((pharmacy_today())::timestamp + interval \'30 minutes\') AT TIME ZONE pharmacy_tz() WHERE id = $1', [x.id]);
    const s = await summary(d, d);
    assert.equal(Number(s.net_sales), 88, '83 + 5');
    const daily = await db.q('SELECT to_char(day, \'YYYY-MM-DD\') AS day, net_sales FROM report_sales_daily($1::date, $2::date)', [d, d]);
    assert.equal(daily.length, 1);
    assert.equal(Number(daily[0].net_sales), 88);
    // يوم أمس بتوقيت الصيدلية لازم يكون فاضي
    const y = await db.q1(`SELECT to_char(pharmacy_today() - 1, 'YYYY-MM-DD') AS d`);
    assert.equal(Number((await summary(y.d, y.d)).net_sales), 0);
  });

  it('تواريخ تقرير غير صالحة بترجع للافتراضي ومبتكسرش الصفحة', async () => {
    const rep = await app.request('GET', '/reports?from=abc&to=2026-99-99', { user: T.ADMIN });
    assert.equal(rep.status, 200, rep.text);
    assert.match(rep.json.from, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('الكاشير مينفعش يفتح التقارير', async () => {
    const rep = await app.request('GET', '/reports', { user: T.CASHIER });
    assert.notEqual(rep.status, 200);
  });
});
