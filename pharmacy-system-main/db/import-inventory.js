// db/import-inventory.js
// بينقل كل أدوية "دليل الأدوية" (جدول drug_reference) لجدول الأصناف والمخزون (medicines)،
// وبيحدد لكل دواء نوعه (قرص/كبسول/حقنة/بخاخة/شراب/كريم...) ووحداته (حبة/شريط/علبة أو وحدة واحدة).
//
// الاستخدام:
//   npm run import-drugs        (مرة واحدة: يملأ دليل الأدوية من data/egyptian-drugs.json)
//   npm run import-inventory    (ينقل الدليل للمخزون - آمن تشغيله أكتر من مرة)
//
// - الكمية في المخزون = 0 لكل صنف جديد (استلم البضاعة من صفحة التشغيلات).
// - أي صنف موجود عندك بنفس الاسم مبيتلمسش (لا السعر ولا المخزون)؛ بس بنسجّل له النوع لو مش متسجل.
// - تقدر تعدّل عدد الحبات/الشرائط لأي صنف من صفحة الأصناف بعد كده.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');
const { classifyDrug } = require('../lib/drug-form');

const BATCH = 1000;
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(fs.readFileSync(path.join(__dirname, 'migration_forms.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, 'drug_reference.sql'), 'utf8'));

    const { rows: refs } = await client.query('SELECT * FROM drug_reference ORDER BY id');
    if (!refs.length) {
      console.log('⚠️  دليل الأدوية فاضي. شغّل الأول: npm run import-drugs');
      return;
    }
    console.log(`📦 دليل الأدوية: ${refs.length} صنف`);

    // الأصناف الموجودة بالفعل (بالاسم أو بالربط)
    const { rows: existing } = await client.query('SELECT id, lower(name) AS lname, ref_id, form_kind FROM medicines');
    const byName = new Map(existing.map((m) => [m.lname, m]));
    const usedRef = new Set(existing.filter((m) => m.ref_id).map((m) => m.ref_id));

    const toInsert = [];
    const toTag = []; // أصناف موجودة بنفس الاسم: نسجّل نوعها بس
    const seen = new Set();
    for (const d of refs) {
      const lname = d.name_en.trim().toLowerCase();
      const form = classifyDrug(d);
      const ex = byName.get(lname);
      if (ex) {
        if (!ex.form_kind) toTag.push({ id: ex.id, ref_id: usedRef.has(d.id) ? null : d.id, kind: form.kind, form: form.dosageForm });
        continue;
      }
      if (usedRef.has(d.id) || seen.has(lname)) continue; // مكرر
      seen.add(lname);
      const box = Number(d.price_egp) || 0;
      const perStrip = r2(box / form.stripsPerBox);
      const perUnit = r2(box / (form.unitsPerStrip * form.stripsPerBox));
      toInsert.push({
        name: d.name_en.trim(), generic: d.scientific_name, form: form.dosageForm, kind: form.kind,
        manufacturer: d.manufacturer, barcode: d.barcode || null, ups: form.unitsPerStrip, spb: form.stripsPerBox,
        unit: perUnit, strip: perStrip, box, ref_id: d.id
      });
    }
    console.log(`➕ جديد: ${toInsert.length} | 🏷️ أصناف موجودة هنسجّل نوعها: ${toTag.length}`);

    await client.query('BEGIN');
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const c = toInsert.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO medicines (name, generic_name, category, dosage_form, form_kind, manufacturer, barcode,
                                units_per_strip, strips_per_box, sale_price_unit, sale_price_strip, sale_price_box,
                                cost_price_unit, stock_units, min_stock_units, ref_id)
         SELECT t.name, t.generic, 'أدوية', t.form, t.kind, t.manufacturer, NULLIF(t.barcode, ''),
                t.ups, t.spb, t.unit, t.strip, t.box, 0, 0, 0, t.ref_id
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::int[], $8::int[], $9::numeric[], $10::numeric[], $11::numeric[], $12::int[])
              AS t(name, generic, form, kind, manufacturer, barcode, ups, spb, unit, strip, box, ref_id)
         ON CONFLICT DO NOTHING`,
        [
          c.map((r) => r.name), c.map((r) => r.generic), c.map((r) => r.form), c.map((r) => r.kind),
          c.map((r) => r.manufacturer), c.map((r) => r.barcode),
          c.map((r) => r.ups), c.map((r) => r.spb), c.map((r) => r.unit), c.map((r) => r.strip), c.map((r) => r.box),
          c.map((r) => r.ref_id)
        ]
      );
      process.stdout.write(`\r⏳ ${Math.min(i + BATCH, toInsert.length)} / ${toInsert.length}`);
    }
    for (const t of toTag) {
      await client.query(
        `UPDATE medicines SET form_kind = $2, dosage_form = COALESCE(dosage_form, $3), ref_id = COALESCE(ref_id, $4) WHERE id = $1`,
        [t.id, t.kind, t.form, t.ref_id]
      );
    }
    await client.query('COMMIT');

    const { rows: [{ c }] } = await client.query('SELECT COUNT(*)::int AS c FROM medicines WHERE is_active = true');
    const { rows: kinds } = await client.query(
      'SELECT dosage_form, COUNT(*)::int AS n FROM medicines WHERE is_active = true GROUP BY 1 ORDER BY n DESC LIMIT 12');
    console.log(`\n✅ تم. عدد الأصناف دلوقتي: ${c}`);
    kinds.forEach((k) => console.log(`   ${k.dosage_form || '—'}: ${k.n}`));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ فشل النقل:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
