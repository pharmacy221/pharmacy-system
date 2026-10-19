// routes/reorder.js
// النواقص الذكية: بدل ما تعتمد على "حد أدنى" ثابت، بنحسب سرعة بيع كل صنف (آخر N يوم) ونعرف هيخلص بعد كام يوم،
// ونقترح الكمية (بالعلب) اللي تكفي مدة التغطية، مجمّعة على آخر مورد اشترينا منه الصنف مع آخر سعر.
// القراءة فقط — الطلبية بتتنسخ/تتطبع/تتبعت واتساب، وتسجيل الشراء الفعلي من صفحة المشتريات.
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/auth');
const { waNumber } = require('../lib/phone');

const router = express.Router();
router.use(requireRole('admin', 'pharmacist'));

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : def;
};

// منطق الاقتراح (نقي — متختبر لوحده)
function suggest({ sold, windowDays, sellable, minStock, unitsPerBox, leadDays, coverDays }) {
  if (!(sold > 0)) return null;                                          // مفيش طلب على الصنف في الفترة: مش هنقترح شراءه
  const velocity = sold / windowDays;                                  // حبة/يوم
  const daysCover = sellable / velocity;
  const lowByMin = minStock > 0 && sellable <= minStock;
  const lowByVelocity = daysCover <= leadDays;
  if (!lowByMin && !lowByVelocity) return null;
  let target = Math.ceil(velocity * coverDays);
  if (minStock > 0) target = Math.max(target, minStock);
  const needUnits = target - sellable;
  if (needUnits <= 0) return null;
  const boxes = Math.max(1, Math.ceil(needUnits / Math.max(unitsPerBox, 1)));
  const urgent = sellable <= 0 || daysCover <= Math.max(2, Math.floor(leadDays / 2));
  return { velocity, daysCover, needUnits, boxes, urgent };
}

router.get('/', async (req, res, next) => {
  try {
    const windowDays = clampInt(req.query.window, 30, 7, 180);
    const leadDays = clampInt(req.query.lead, 7, 1, 60);
    const coverDays = clampInt(req.query.cover, 21, 3, 180);

    const rows = await query(
      `WITH sold AS (
         SELECT si.medicine_id, SUM(si.quantity_units)::int AS units
         FROM sale_items si JOIN sale_invoices i ON i.id = si.invoice_id
         WHERE i.status = 'completed' AND si.medicine_id IS NOT NULL
           AND i.created_at >= now() - make_interval(days => $1::int)
         GROUP BY si.medicine_id
       ), rets AS (
         SELECT r.medicine_id, SUM(r.quantity_units)::int AS units
         FROM returns r JOIN sale_invoices i ON i.id = r.invoice_id
         WHERE i.status = 'completed' AND r.medicine_id IS NOT NULL
           AND r.created_at >= now() - make_interval(days => $1::int)
         GROUP BY r.medicine_id
       ), stock AS (
         SELECT medicine_id,
                COALESCE(SUM(quantity_units) FILTER (WHERE expiry_date >= pharmacy_today()), 0)::int AS sellable,
                COALESCE(SUM(quantity_units) FILTER (WHERE expiry_date < pharmacy_today()), 0)::int AS expired
         FROM batches WHERE quantity_units > 0 GROUP BY medicine_id
       ), last_buy AS (
         SELECT DISTINCT ON (pii.medicine_id) pii.medicine_id, pi.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
                pii.cost_price_unit AS last_cost_unit, to_char(pi.invoice_date, 'YYYY-MM-DD') AS last_buy_date
         FROM purchase_invoice_items pii
         JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'received'
         JOIN suppliers s ON s.id = pi.supplier_id
         ORDER BY pii.medicine_id, pi.invoice_date DESC, pii.id DESC
       )
       SELECT m.id, m.name, m.generic_name, m.min_stock_units, m.units_per_strip, m.strips_per_box,
              m.cost_price_unit, COALESCE(sd.units, 0) - COALESCE(rt.units, 0) AS sold,
              COALESCE(st.sellable, 0) AS sellable, COALESCE(st.expired, 0) AS expired,
              lb.supplier_id, lb.supplier_name, lb.supplier_phone, lb.last_cost_unit, lb.last_buy_date
       FROM medicines m
       LEFT JOIN sold sd ON sd.medicine_id = m.id
       LEFT JOIN rets rt ON rt.medicine_id = m.id
       LEFT JOIN stock st ON st.medicine_id = m.id
       LEFT JOIN last_buy lb ON lb.medicine_id = m.id
       WHERE m.is_active = true
         AND COALESCE(sd.units, 0) > 0`,
      [windowDays]
    );

    const groups = new Map();
    let totalLines = 0;
    let urgentLines = 0;
    let estTotal = 0;
    for (const r of rows) {
      const unitsPerBox = Math.max((r.units_per_strip || 1) * (r.strips_per_box || 1), 1);
      const s = suggest({
        sold: Math.max(r.sold, 0), windowDays, sellable: r.sellable, minStock: r.min_stock_units || 0,
        unitsPerBox, leadDays, coverDays
      });
      if (!s) continue;
      const unitCost = Number(r.last_cost_unit != null ? r.last_cost_unit : r.cost_price_unit) || 0;
      const line = {
        id: r.id, name: r.name, sellable: r.sellable, expired: r.expired, sold: Math.max(r.sold, 0),
        velocity: s.velocity, daysCover: s.daysCover, boxes: s.boxes, urgent: s.urgent,
        unitsPerBox, estCost: Math.round(unitCost * unitsPerBox * s.boxes * 100) / 100,
        boxCost: Math.round(unitCost * unitsPerBox * 100) / 100,
        lastBuyDate: r.last_buy_date
      };
      const key = r.supplier_id || 0;
      if (!groups.has(key)) {
        groups.set(key, {
          supplierId: r.supplier_id, supplierName: r.supplier_name || 'بدون مورد سابق (اختار المورد وقت الشراء)',
          wa: waNumber(r.supplier_phone), items: []
        });
      }
      groups.get(key).items.push(line);
      totalLines += 1;
      if (s.urgent) urgentLines += 1;
      estTotal += line.estCost;
    }
    const list = [...groups.values()].map((g) => {
      g.items.sort((a, b) => (b.urgent - a.urgent) || ((a.daysCover ?? -1) - (b.daysCover ?? -1)) || a.name.localeCompare(b.name, 'ar'));
      g.estCost = Math.round(g.items.reduce((t, i) => t + i.estCost, 0) * 100) / 100;
      return g;
    }).sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || b.items.length - a.items.length);

    res.render('reorder', {
      groups: list, totalLines, urgentLines, estTotal: Math.round(estTotal * 100) / 100,
      windowDays, leadDays, coverDays, active: 'reorder'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.suggest = suggest;
