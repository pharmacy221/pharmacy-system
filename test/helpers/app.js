// test/helpers/app.js
// shim بسيط لـ express: بيركّب الـ routers الحقيقية (من routes/) على سيرفر HTTP حقيقي، بجلسة مزيفة
// بتتحدد من الهيدر x-test-user (1 أدمن / 2 صيدلي / 3 كاشير)، وبيستبدل res.render بـ JSON فيه اسم الـ view
// والبيانات (عشان نختبر منطق الـ routes من غير ما نحتاج الـ views/الجلسات/connect-pg-simple).
const http = require('http');
const express = require('express');

const USERS = { 1: { role: 'admin', username: 'admin' }, 2: { role: 'pharmacist', username: 'pharma' }, 3: { role: 'cashier', username: 'cashier' }, 4: { role: 'cashier', username: 'cashier2' } };

async function startApp(mounts) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = parseInt(req.get('x-test-user'), 10);
    req.session = USERS[uid] ? { userId: uid, ...USERS[uid] } : {};
    res.locals.shopName = 'test';
    res.render = (view, data) => res.json({ __view: view, ...data });
    next();
  });
  for (const [p, router] of Object.entries(mounts)) app.use(p, router);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ __unhandled: String(err && err.message) });
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, { user, body, form } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = String(user);
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    else if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, text, json, location: res.headers.get('location') };
  }
  return { request, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startApp };
