// اختبار الصلاحيات (requireRole / requireAdmin) من غير express ولا قاعدة بيانات
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireRole, requireAdmin, requireLogin } = require('../middleware/auth');

function run(mw, session, headers = {}) {
  const out = { nextCalled: false, status: null, body: null, redirect: null };
  const req = { session, headers, xhr: false };
  const res = {
    status(c) { out.status = c; return this; },
    send(b) { out.body = b; return this; },
    json(b) { out.body = b; out.json = true; return this; },
    redirect(u) { out.redirect = u; return this; }
  };
  mw(req, res, () => { out.nextCalled = true; });
  return out;
}

describe('الصلاحيات', () => {
  const refunds = requireRole('admin', 'pharmacist');   // المرتجعات + استلام التشغيلات

  it('الكاشير مرفوض (403) ومبيكملش للـ handler', () => {
    const r = run(refunds, { userId: 3, role: 'cashier' });
    assert.equal(r.nextCalled, false);
    assert.equal(r.status, 403);
  });

  it('الأدمن والصيدلي مسموح لهم', () => {
    assert.equal(run(refunds, { userId: 1, role: 'admin' }).nextCalled, true);
    assert.equal(run(refunds, { userId: 2, role: 'pharmacist' }).nextCalled, true);
  });

  it('غير مسجل دخول: redirect للـ login', () => {
    assert.equal(run(refunds, {}).redirect, '/login');
    assert.equal(run(refunds, undefined).redirect, '/login');
    assert.equal(run(refunds, { role: 'admin' }).nextCalled, false, 'role من غير userId مش كفاية');
  });

  it('طلب JSON مرفوض بـ 403 JSON', () => {
    const r = run(refunds, { userId: 3, role: 'cashier' }, { accept: 'application/json' });
    assert.equal(r.status, 403);
    assert.equal(r.json, true);
  });

  it('دور غير معروف أو undefined مرفوض', () => {
    assert.equal(run(refunds, { userId: 9, role: 'hacker' }).nextCalled, false);
    assert.equal(run(refunds, { userId: 9 }).nextCalled, false);
  });

  it('requireAdmin: الأدمن فقط (الإلغاء)، والصيدلي والكاشير ما ينفذوش', () => {
    assert.equal(run(requireAdmin, { userId: 1, role: 'admin' }).nextCalled, true);
    for (const role of ['pharmacist', 'cashier']) {
      const r = run(requireAdmin, { userId: 2, role });
      assert.equal(r.nextCalled, false);
      assert.equal(r.redirect, '/pos');
    }
  });

  it('requireLogin', () => {
    assert.equal(run(requireLogin, { userId: 1 }).nextCalled, true);
    assert.equal(run(requireLogin, {}).redirect, '/login');
  });
});
