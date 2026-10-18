// db/report-stock-mismatch.js
// تقرير فروق المخزون (قراءة فقط — مفيش أي تعديل على البيانات):
//   1) أصناف إجمالي مخزونها (medicines.stock_units) مختلف عن مجموع تشغيلاتها
//   2) أصناف فيها كمية في تشغيلات منتهية (مش هتتباع)
//   3) فواتير قديمة مش مربوطة بوردية / وورديات مفتوحة
// تشغيل:  node db/report-stock-mismatch.js [--json]
require('dotenv').config();
const { pool } = require('./index');

async function main() {
  const asJson = process.argv.includes('--json');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const mismatch = (await client.query(`
      SELECT m.id AS medicine_id, m.name, m.stock_units,
             COALESCE(b.total_units, 0)::int AS batches_units,
             (m.stock_units - COALESCE(b.total_units, 0))::int AS difference
      FROM medicines m
      LEFT JOIN (SELECT medicine_id, SUM(quantity_units) AS total_units FROM batches GROUP BY medicine_id) b
             ON b.medicine_id = m.id
      WHERE m.stock_units <> COALESCE(b.total_units, 0)
      ORDER BY abs(m.stock_units - COALESCE(b.total_units, 0)) DESC, m.id
    `)).rows;

    const hasToday = (await client.query(`SELECT to_regproc('pharmacy_today') IS NOT NULL AS ok`)).rows[0].ok;
    const todayExpr = hasToday ? 'pharmacy_today()' : 'CURRENT_DATE';
    const expired = (await client.query(`
      SELECT m.id AS medicine_id, m.name, SUM(b.quantity_units)::int AS expired_units
      FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.quantity_units > 0 AND b.expiry_date < ${todayExpr}
      GROUP BY m.id, m.name ORDER BY expired_units DESC
    `)).rows;

    const hasShiftCol = (await client.query(`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sale_invoices' AND column_name = 'shift_id') AS ok
    `)).rows[0].ok;
    const unlinked = hasShiftCol
      ? Number((await client.query(`SELECT COUNT(*) AS c FROM sale_invoices WHERE shift_id IS NULL`)).rows[0].c)
      : null;
    const openShifts = (await client.query(`
      SELECT s.id, s.opened_by, s.opened_at FROM shifts s WHERE s.closed_at IS NULL ORDER BY s.id
    `)).rows;

    await client.query('ROLLBACK');

    if (asJson) {
      console.log(JSON.stringify({ mismatch, expired, invoices_without_shift: unlinked, open_shifts: openShifts }, null, 2));
      return;
    }
    console.log(`\n== فروق المخزون (إجمالي الصنف ≠ مجموع التشغيلات): ${mismatch.length} صنف`);
    if (mismatch.length) console.table(mismatch);
    console.log(`\n== أصناف بكميات في تشغيلات منتهية: ${expired.length} صنف`);
    if (expired.length) console.table(expired);
    console.log(`\n== فواتير غير مربوطة بوردية: ${unlinked === null ? 'غير متاح (migration_002 لسه متطبقتش)' : unlinked}`);
    console.log(`== ورديات مفتوحة (اقفلها قبل التحديث): ${openShifts.length}`);
    if (openShifts.length) console.table(openShifts);
    console.log('\nالتقرير للقراءة فقط — لا يتم تصحيح أي رقم تلقائيًا. التصحيح يتم يدويًا بتسوية مخزون مسجلة بعد المراجعة.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ فشل إنشاء التقرير:', err.message);
  process.exit(1);
});
