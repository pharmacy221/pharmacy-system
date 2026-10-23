// lib/official-prices.js
// الأسعار الرسمية (جدول drug_reference.price_egp = سعر العلبة الرسمي) مقابل أسعار البيع في medicines.
// نفس معادلة التقسيم المستخدمة في db/import-inventory.js: الحبة = العلبة ÷ (حبات الشريط × شرائط العلبة)، الشريط = العلبة ÷ شرائط العلبة.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// سعر العلبة الحالي عندنا (لو سعر العلبة مش مسجّل بيتحسب من سعر الحبة)
function currentBox(m) {
  const ups = Math.max(parseInt(m.units_per_strip) || 1, 1);
  const spb = Math.max(parseInt(m.strips_per_box) || 1, 1);
  if (m.sale_price_box != null && Number(m.sale_price_box) > 0) return r2(m.sale_price_box);
  return r2(Number(m.sale_price_unit) * ups * spb);
}

// الأسعار الجديدة لو طبّقنا السعر الرسمي (للحبة/الشريط/العلبة)
function officialTarget(m, officialBox) {
  const ups = Math.max(parseInt(m.units_per_strip) || 1, 1);
  const spb = Math.max(parseInt(m.strips_per_box) || 1, 1);
  const box = r2(officialBox);
  return { box, strip: r2(box / spb), unit: r2(box / (ups * spb)) };
}

// فرق بالجنيه بين سعرنا والرسمي (موجب = أغلى من الرسمي). الفرق أقل من قرش = مفيش فرق
function boxDiff(m, officialBox) {
  const d = r2(currentBox(m) - Number(officialBox));
  return Math.abs(d) < 0.01 ? 0 : d;
}

module.exports = { r2, currentBox, officialTarget, boxDiff };
