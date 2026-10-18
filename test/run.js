// يشغّل كل ملفات *.test.js بالتسلسل (قواعد بيانات الاختبار منفصلة لكل ملف، والتسلسل بيمنع تداخل الـ locks).
// بيشتغل على أي نظام (بدون الاعتماد على glob بتاع الـ shell).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(__dirname, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
