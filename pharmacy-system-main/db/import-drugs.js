// db/import-drugs.js
// بيحمّل قاعدة الأدوية المصرية (data/egyptian-drugs.json) في جدول drug_reference.
// شغّله:  npm run import-drugs
// تقدر تشغّله تاني في أي وقت لتحديث الداتا (بيمسح القديم ويحط الجديد).
//
// لتحديث الملف نفسه من المصدر الأصلي (CC0):
//   curl -L -o data/egyptian-drugs.json https://raw.githubusercontent.com/karem505/egyptian-drug-database/main/data/egyptian-drugs.json
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

const BATCH = 1000;
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

async function main() {
  const file = path.join(__dirname, '..', 'data', 'egyptian-drugs.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`📦 قرأت ${rows.length} صنف من الملف...`);

  const sqlFile = fs.readFileSync(path.join(__dirname, 'drug_reference.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sqlFile); // بيتأكد إن الجدول موجود
    await client.query('TRUNCATE drug_reference RESTART IDENTITY');

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).filter((r) => clean(r.commercial_name_en));
      await client.query(
        `INSERT INTO drug_reference (name_en, name_ar, scientific_name, manufacturer, drug_class, route, price_egp, barcode)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[])`,
        [
          chunk.map((r) => clean(r.commercial_name_en)),
          chunk.map((r) => clean(r.commercial_name_ar)),
          chunk.map((r) => clean(r.scientific_name)),
          chunk.map((r) => clean(r.manufacturer)),
          chunk.map((r) => clean(r.drug_class)),
          chunk.map((r) => clean(r.route)),
          chunk.map((r) => (Number.isFinite(Number(r.price_egp)) ? Number(r.price_egp) : null)),
          chunk.map((r) => clean(r.barcode)) // اختياري: لو الملف فيه حقل barcode
        ]
      );
      process.stdout.write(`\r⏳ ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
    }
    await client.query('COMMIT');
    const { rows: [{ c }] } = await client.query('SELECT COUNT(*)::int AS c FROM drug_reference');
    console.log(`\n✅ تم. الجدول فيه دلوقتي ${c} صنف.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ فشل الاستيراد:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
