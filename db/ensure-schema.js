// db/ensure-schema.js
// بيتأكد إن أعمدة "كلمة الاختصار" و"المقاسات" (migration_010) موجودة؛ الملف idempotent وسريع.
// بيتشغّل مرة واحدة لكل عملية سيرفر، فلو نسيت تشغّل `npm run migrate` الصفحات ماتقعش.
const fs = require('fs');
const path = require('path');

let ready = null;
function ensureSchema(pool) {
  if (!ready) {
    ready = pool.query(fs.readFileSync(path.join(__dirname, 'migration_010_shortcut_sizes.sql'), 'utf8'))
      .then(() => pool.query(`INSERT INTO schema_migrations (name) VALUES ('migration_010_shortcut_sizes.sql') ON CONFLICT DO NOTHING`).catch(() => {}))
      .catch((err) => { console.error('⚠️ تعذّر تطبيق migration_010 تلقائيًا (شغّل: npm run migrate):', err.message); });
  }
  return ready;
}
module.exports = { ensureSchema };
