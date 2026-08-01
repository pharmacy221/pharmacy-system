// db/seed.js
// شغّله مرة واحدة بعد ما تنشئ الجداول بملف pharmacy_schema.sql في Supabase:
//   node db/seed.js
// بيعمل مستخدم أدمن افتراضي، لو مفيش أي مستخدم موجود.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, queryOne, pool } = require('./index');

async function main() {
  const userCount = await queryOne('SELECT COUNT(*)::int AS c FROM users');

  if (userCount.c === 0) {
    const username = 'admin';
    const password = 'ChangeMe123!';
    const hash = bcrypt.hashSync(password, 10);
    await query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)',
      [username, hash, 'مدير الصيدلية', 'admin']
    );
    console.log('\n👤 تم إنشاء مستخدم أدمن افتراضي:');
    console.log('   اسم المستخدم: admin');
    console.log('   كلمة المرور : ChangeMe123!');
    console.log('   ⚠️  غيّر كلمة المرور فورًا بعد أول تسجيل دخول من صفحة الإعدادات.\n');
  } else {
    console.log(`ℹ️  يوجد ${userCount.c} مستخدم/مستخدمين بالفعل، مش هينشئ أدمن جديد.`);
  }

  const settingsCount = await queryOne("SELECT COUNT(*)::int AS c FROM settings WHERE key = 'pharmacy_name'");
  if (settingsCount.c === 0) {
    await query(
      `INSERT INTO settings (key, value) VALUES ('pharmacy_name', 'الصيدلية') ON CONFLICT (key) DO NOTHING`
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('❌ حصل خطأ أثناء الـ seed:', err);
  process.exit(1);
});
