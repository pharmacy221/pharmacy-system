// lib/refills.js
// تذكيرات إعادة الصرف للأدوية المزمنة. آخر صرف بيتحسب من فواتير العميل الفعلية (مفيش حاجة تتنسّى تتحدّث).
const { query } = require('../db');

// كل التواريخ بترجع نص YYYY-MM-DD (مفيش تحويلات توقيت)
const REFILLS_BASE = `
  SELECT r.id, r.customer_id, r.medicine_id, r.interval_days, r.notes,
         to_char(r.snoozed_until, 'YYYY-MM-DD') AS snoozed_until,
         c.name AS customer_name, c.phone AS customer_phone, m.name AS medicine_name,
         to_char(COALESCE(l.last_date, r.start_date), 'YYYY-MM-DD') AS last_date,
         to_char(COALESCE(l.last_date, r.start_date) + r.interval_days, 'YYYY-MM-DD') AS next_due,
         (pharmacy_today() - (COALESCE(l.last_date, r.start_date) + r.interval_days))::int AS days_overdue
  FROM customer_refills r
  JOIN customers c ON c.id = r.customer_id AND c.is_active
  JOIN medicines m ON m.id = r.medicine_id
  LEFT JOIN LATERAL (
    SELECT MAX(pharmacy_date(i.created_at)) AS last_date
    FROM sale_invoices i
    JOIN sale_items si ON si.invoice_id = i.id
    WHERE i.customer_id = r.customer_id AND i.status = 'completed' AND si.medicine_id = r.medicine_id
  ) l ON true
  WHERE r.is_active`;

// التذكيرات المستحقة (متأخرة أو خلال withinDays يوم) وغير المؤجّلة
async function dueRefills({ withinDays = 3, customerIds = null, limit = 500 } = {}) {
  const params = [withinDays, limit];
  let extra = '';
  if (customerIds) {
    params.push(customerIds);
    extra = ` AND r.customer_id = ANY($${params.length}::int[])`;
  }
  return query(
    `SELECT * FROM (${REFILLS_BASE}
        AND (r.snoozed_until IS NULL OR r.snoozed_until <= pharmacy_today())${extra}) x
     WHERE x.days_overdue >= -$1::int
     ORDER BY x.days_overdue DESC, x.customer_name
     LIMIT $2`,
    params
  );
}

// اقتراحات ذكية: عميل اشترى نفس الصنف 3 مرات أو أكتر في آخر سنة بفواصل منتظمة ومفيش تذكير متسجّل له
async function suggestedRefills(limit = 30) {
  return query(
    `WITH buys AS (
       SELECT DISTINCT i.customer_id, si.medicine_id, pharmacy_date(i.created_at) AS d
       FROM sale_invoices i
       JOIN sale_items si ON si.invoice_id = i.id
       WHERE i.customer_id IS NOT NULL AND i.status = 'completed' AND si.medicine_id IS NOT NULL
         AND i.created_at > now() - interval '365 days'
     ), gaps AS (
       SELECT customer_id, medicine_id, d,
              d - LAG(d) OVER (PARTITION BY customer_id, medicine_id ORDER BY d) AS gap
       FROM buys
     ), agg AS (
       SELECT customer_id, medicine_id, COUNT(*)::int AS purchases, ROUND(AVG(gap))::int AS avg_gap, MAX(d) AS last_d
       FROM gaps
       GROUP BY customer_id, medicine_id
       HAVING COUNT(*) >= 3 AND AVG(gap) BETWEEN 7 AND 120
     )
     SELECT agg.customer_id, agg.medicine_id, agg.purchases, agg.avg_gap,
            to_char(agg.last_d, 'YYYY-MM-DD') AS last_date,
            c.name AS customer_name, c.phone AS customer_phone, m.name AS medicine_name
     FROM agg
     JOIN customers c ON c.id = agg.customer_id AND c.is_active
     JOIN medicines m ON m.id = agg.medicine_id
     WHERE NOT EXISTS (SELECT 1 FROM customer_refills r WHERE r.customer_id = agg.customer_id AND r.medicine_id = agg.medicine_id)
     ORDER BY agg.last_d DESC
     LIMIT $1`,
    [limit]
  );
}

module.exports = { REFILLS_BASE, dueRefills, suggestedRefills };
