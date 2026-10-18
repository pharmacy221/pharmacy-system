// lib/sales-reports.js
// حسابات المبيعات المشتركة بين الداشبورد والتقارير: بتستدعي دوال قاعدة البيانات report_*
// (نفس المصدر = نفس الأرقام). revenue = صافي المبيعات (بعد المرتجعات)، والفواتير الملغاة بره الحساب.
// كل التواريخ بتوقيت الصيدلية (pharmacy_today) مش توقيت السيرفر.
const { query, queryOne } = require('../db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// تاريخ صالح بصيغة YYYY-MM-DD أو null
function validDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

// تواريخ مرجعية بتوقيت الصيدلية
async function pharmacyDates() {
  const r = await queryOne(`
    SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS today,
           to_char(pharmacy_today() - 6, 'YYYY-MM-DD') AS week_start,
           to_char(pharmacy_today() - 13, 'YYYY-MM-DD') AS two_weeks_start,
           to_char(date_trunc('month', pharmacy_today()), 'YYYY-MM-DD') AS month_start
  `);
  return { today: r.today, weekStart: r.week_start, twoWeeksStart: r.two_weeks_start, monthStart: r.month_start };
}

async function salesSummary(from, to) {
  const r = await queryOne('SELECT * FROM report_sales_summary($1::date, $2::date)', [from, to]);
  return {
    revenue: Number(r.net_sales),          // صافي المبيعات
    profit: Number(r.net_profit),
    count: Number(r.invoice_count),
    gross: Number(r.gross_sales),
    returns: Number(r.returns_total),
    returnsCount: Number(r.returns_count)
  };
}

async function salesDaily(from, to) {
  const rows = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, net_sales, net_profit, gross_sales, returns_total, invoice_count
     FROM report_sales_daily($1::date, $2::date)`, [from, to]);
  return rows.map((r) => ({
    day: r.day, revenue: Number(r.net_sales), profit: Number(r.net_profit),
    gross: Number(r.gross_sales), returns: Number(r.returns_total), count: Number(r.invoice_count)
  }));
}

async function topMedicines(from, to, limit = 10) {
  const rows = await query('SELECT * FROM report_top_medicines($1::date, $2::date, $3)', [from, to, limit]);
  return rows.map((r) => ({ name: r.name, units_sold: Number(r.units_sold), revenue: Number(r.revenue) }));
}

module.exports = { validDate, pharmacyDates, salesSummary, salesDaily, topMedicines };
