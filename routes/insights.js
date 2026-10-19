// routes/insights.js
// تحليلات الصيدلية (أدمن): فين الفلوس واقفة؟ إيه بيجيب الربح؟ إمتى الزحمة؟
// كلها قراءة فقط. الأرباح هنا تقريبية على مستوى البند (بعد توزيع الخصم، قبل أثر المرتجعات) —
// الأرقام الرسمية في صفحة التقارير.
const express = require('express');
const { query, queryOne } = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

// بنود الفترة بعد توزيع خصم الفاتورة على بنودها
const LINES_CTE = `
  inv_tot AS (SELECT invoice_id, SUM(total) AS t FROM sale_items GROUP BY invoice_id),
  lines AS (
    SELECT si.medicine_id, si.medicine_name_snapshot AS name, COALESCE(m.category, 'غير مصنّف') AS category,
           si.quantity_units,
           si.total * CASE WHEN it.t > 0 THEN i.total / it.t ELSE 1 END AS net,
           COALESCE(si.cost_price_unit_snapshot, 0) * si.quantity_units AS cost,
           i.created_at, i.customer_id
    FROM sale_items si
    JOIN sale_invoices i ON i.id = si.invoice_id AND i.status = 'completed'
    JOIN inv_tot it ON it.invoice_id = i.id
    LEFT JOIN medicines m ON m.id = si.medicine_id
    WHERE i.created_at >= now() - make_interval(days => $1::int)
  )`;

router.get('/', async (req, res, next) => {
  try {
    const days = [30, 90, 180, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 90;

    const [kpi, abcRows, heat, dead, expiry, cats, customers] = await Promise.all([
      queryOne(
        `SELECT
           (SELECT COALESCE(SUM(stock_units * cost_price_unit), 0) FROM medicines WHERE is_active) AS stock_value,
           (SELECT COALESCE(SUM(b.quantity_units * b.cost_price_unit), 0) FROM batches b
              WHERE b.quantity_units > 0 AND b.expiry_date < pharmacy_today()) AS expired_value,
           (SELECT COALESCE(SUM(b.quantity_units * b.cost_price_unit), 0) FROM batches b
              WHERE b.quantity_units > 0 AND b.expiry_date >= pharmacy_today() AND b.expiry_date <= pharmacy_today() + 90) AS expiring_value,
           (SELECT COALESCE(SUM(balance), 0) FROM customers WHERE balance > 0) AS receivables,
           (SELECT COALESCE(SUM(balance_due), 0) FROM v_supplier_balances) AS payables`
      ),
      query(`WITH ${LINES_CTE}
             SELECT name, SUM(net)::numeric(14,2) AS net, SUM(net - cost)::numeric(14,2) AS profit, SUM(quantity_units)::int AS units
             FROM lines WHERE medicine_id IS NOT NULL GROUP BY medicine_id, name
             HAVING SUM(net - cost) > 0 ORDER BY profit DESC`, [days]),
      query(`SELECT EXTRACT(DOW FROM i.created_at AT TIME ZONE pharmacy_tz())::int AS dow,
                    EXTRACT(HOUR FROM i.created_at AT TIME ZONE pharmacy_tz())::int AS hour,
                    COUNT(*)::int AS n
             FROM sale_invoices i
             WHERE i.status = 'completed' AND i.created_at >= now() - make_interval(days => $1::int)
             GROUP BY 1, 2`, [days]),
      query(`SELECT m.id, m.name, m.stock_units, (m.stock_units * m.cost_price_unit)::numeric(14,2) AS value,
                    to_char(MAX(pharmacy_date(i.created_at)), 'YYYY-MM-DD') AS last_sale
             FROM medicines m
             LEFT JOIN sale_items si ON si.medicine_id = m.id
             LEFT JOIN sale_invoices i ON i.id = si.invoice_id AND i.status = 'completed'
             WHERE m.is_active AND m.stock_units > 0 AND m.cost_price_unit > 0
             GROUP BY m.id
             HAVING MAX(i.created_at) IS NULL OR MAX(i.created_at) < now() - interval '90 days'
             ORDER BY value DESC LIMIT 15`),
      query(`WITH sold AS (
               SELECT si.medicine_id, SUM(si.quantity_units)::numeric / 30 AS per_day
               FROM sale_items si JOIN sale_invoices i ON i.id = si.invoice_id
               WHERE i.status = 'completed' AND i.created_at >= now() - interval '30 days' AND si.medicine_id IS NOT NULL
               GROUP BY si.medicine_id)
             SELECT m.name, b.batch_number, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
                    (b.expiry_date - pharmacy_today())::int AS days_left, b.quantity_units,
                    GREATEST(b.quantity_units - FLOOR(COALESCE(s.per_day, 0) * GREATEST(b.expiry_date - pharmacy_today(), 0)), 0)::int AS at_risk_units,
                    (GREATEST(b.quantity_units - FLOOR(COALESCE(s.per_day, 0) * GREATEST(b.expiry_date - pharmacy_today(), 0)), 0) * b.cost_price_unit)::numeric(14,2) AS at_risk_value
             FROM batches b JOIN medicines m ON m.id = b.medicine_id
             LEFT JOIN sold s ON s.medicine_id = b.medicine_id
             WHERE b.quantity_units > 0 AND b.expiry_date >= pharmacy_today() AND b.expiry_date <= pharmacy_today() + 90
             ORDER BY at_risk_value DESC LIMIT 15`),
      query(`WITH ${LINES_CTE}
             SELECT category, SUM(net)::numeric(14,2) AS net, SUM(net - cost)::numeric(14,2) AS profit,
                    CASE WHEN SUM(net) > 0 THEN ROUND(SUM(net - cost) / SUM(net) * 100, 1) ELSE 0 END AS margin
             FROM lines GROUP BY category ORDER BY profit DESC LIMIT 8`, [days]),
      query(`SELECT c.id, c.name, COUNT(*)::int AS visits, SUM(i.total)::numeric(14,2) AS spent
             FROM sale_invoices i JOIN customers c ON c.id = i.customer_id
             WHERE i.status = 'completed' AND i.created_at >= now() - make_interval(days => $1::int)
             GROUP BY c.id ORDER BY spent DESC LIMIT 8`, [days])
    ]);

    // ABC: A = أول 70% من الربح، B = لحد 90%، C = الباقي
    const totalProfit = abcRows.reduce((t, r) => t + Number(r.profit), 0);
    let cum = 0;
    const abc = abcRows.map((r) => {
      cum += Number(r.profit);
      const share = totalProfit > 0 ? cum / totalProfit : 1;
      return { ...r, cumShare: share, cls: share <= 0.7 || cum === Number(r.profit) ? 'A' : share <= 0.9 ? 'B' : 'C' };
    });
    const abcCount = { A: 0, B: 0, C: 0 };
    abc.forEach((r) => { abcCount[r.cls] += 1; });

    // الزحمة: مصفوفة 7×24
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    let maxCell = 0;
    heat.forEach((h) => { grid[h.dow][h.hour] = h.n; if (h.n > maxCell) maxCell = h.n; });

    res.render('insights', {
      days, kpi, abc: abc.slice(0, 15), abcCount, abcTotal: abc.length, totalProfit,
      grid, maxCell, dead, expiry, cats, customers, active: 'insights'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
