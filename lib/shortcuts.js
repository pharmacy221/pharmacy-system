// lib/shortcuts.js
// اختصارات الكيبورد: الأدمن بيحدد مفتاح كل إجراء من صفحة الإعدادات، والاختيارات بتتخزن في جدول settings (key = 'shortcuts')
// وبتتطبق على كل الصفحات (التنقل) وعلى شاشة الكاشير (إجراءات البيع).
const { query } = require('../db');

// href = إجراء تنقل (بيفتح الصفحة لو الرابط موجود في القائمة لليوزر ده)
// الإجراءات التانية بتتنفذ جوه الصفحة المخصصة لها (الكاشير مثلًا)
const ACTIONS = [
  // --- عام ---
  { id: 'search',        group: 'عام',            label: 'التركيز على خانة البحث', def: 'F2' },
  // --- التنقل ---
  { id: 'nav_home',      group: 'التنقل بين الصفحات', label: 'الرئيسية',            def: 'Alt+0', href: '/' },
  { id: 'nav_pos',       group: 'التنقل بين الصفحات', label: 'الكاشير',             def: 'Alt+1', href: '/pos' },
  { id: 'nav_sales',     group: 'التنقل بين الصفحات', label: 'فواتير البيع',        def: 'Alt+2', href: '/sales' },
  { id: 'nav_returns',   group: 'التنقل بين الصفحات', label: 'المرتجعات',           def: 'Alt+3', href: '/returns' },
  { id: 'nav_products',  group: 'التنقل بين الصفحات', label: 'الأصناف والمخزون',    def: 'Alt+4', href: '/products' },
  { id: 'nav_batches',   group: 'التنقل بين الصفحات', label: 'التشغيلات والصلاحية', def: 'Alt+5', href: '/products/batches' },
  { id: 'nav_drugs',     group: 'التنقل بين الصفحات', label: 'دليل الأدوية',        def: 'Alt+6', href: '/drug-lookup' },
  { id: 'nav_symptom',   group: 'التنقل بين الصفحات', label: 'بحث بالحالة',         def: 'Alt+7', href: '/symptom-search' },
  { id: 'nav_shifts',    group: 'التنقل بين الصفحات', label: 'الوردية',             def: '',      href: '/shifts' },
  { id: 'nav_dashboard', group: 'التنقل بين الصفحات', label: 'لوحة التحكم (أدمن)',  def: '',      href: '/dashboard' },
  { id: 'nav_reports',   group: 'التنقل بين الصفحات', label: 'التقارير (أدمن)',     def: '',      href: '/reports' },
  { id: 'nav_settings',  group: 'التنقل بين الصفحات', label: 'الإعدادات (أدمن)',    def: '',      href: '/settings' },
  // --- الكاشير ---
  { id: 'pos_checkout',  group: 'شاشة الكاشير',   label: 'تسجيل البيع وطباعة الفاتورة', def: 'F9' },
  { id: 'pos_clear',     group: 'شاشة الكاشير',   label: 'تفريغ الفاتورة',       def: '' },
  { id: 'pos_camera',    group: 'شاشة الكاشير',   label: 'مسح الباركود بالكاميرا', def: '' },
  { id: 'pos_instock',   group: 'شاشة الكاشير',   label: 'تبديل "المتاح في المخزون فقط"', def: '' },
  { id: 'pos_pay_cash',  group: 'شاشة الكاشير',   label: 'الدفع: كاش',           def: '' },
  { id: 'pos_pay_card',  group: 'شاشة الكاشير',   label: 'الدفع: بطاقة',         def: '' },
  { id: 'pos_pay_other', group: 'شاشة الكاشير',   label: 'الدفع: أخرى',          def: '' },
  { id: 'pos_tendered',  group: 'شاشة الكاشير',   label: 'خانة المبلغ اللي العميل دفعه (الباقي / فاضل عليه)', def: 'F4' },
  { id: 'pos_discount',  group: 'شاشة الكاشير',   label: 'خانة الخصم اليدوي',    def: '' },
  { id: 'pos_coupon',    group: 'شاشة الكاشير',   label: 'خانة كود الكوبون',     def: '' },
  { id: 'pos_customer',  group: 'شاشة الكاشير',   label: 'خانة اسم العميل',      def: '' },
  { id: 'pos_notes',     group: 'شاشة الكاشير',   label: 'خانة الملاحظات',       def: '' },
  { id: 'pos_qty_up',    group: 'شاشة الكاشير',   label: 'زيادة كمية الصنف المحدد في الفاتورة (+1)', def: 'ArrowRight' },
  { id: 'pos_qty_down',  group: 'شاشة الكاشير',   label: 'تقليل كمية الصنف المحدد (−1، ولو بقت صفر بيتحذف)', def: 'ArrowLeft' },
  { id: 'pos_size_up',   group: 'شاشة الكاشير',   label: 'المقاس الأكبر للصنف المحدد (سرنجات/حفاظات...؛ وللأصناف من غير مقاسات: الوحدة الأكبر)', def: 'ArrowUp' },
  { id: 'pos_size_down', group: 'شاشة الكاشير',   label: 'المقاس الأصغر للصنف المحدد (وللأصناف من غير مقاسات: الوحدة الأصغر)', def: 'ArrowDown' },
  { id: 'pos_item_prev', group: 'شاشة الكاشير',   label: 'تحديد الصنف اللي قبله في الفاتورة', def: '' },
  { id: 'pos_item_next', group: 'شاشة الكاشير',   label: 'تحديد الصنف اللي بعده في الفاتورة', def: '' },
  { id: 'pos_item_del',  group: 'شاشة الكاشير',   label: 'حذف الصنف المحدد من الفاتورة', def: '' }
];

const BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
const NAV_HREFS = Object.fromEntries(ACTIONS.filter((a) => a.href).map((a) => [a.id, a.href]));
const DEFAULTS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.def]));

// الصيغة: Ctrl+Alt+Shift+Meta + المفتاح. المفتاح = F1..F12 / حرف A-Z / رقم 0-9 / Enter / Space / Insert / Delete / Home / End / PageUp / PageDown
// الحروف والأرقام والمسافة لازم معاها Ctrl أو Alt (عشان متعطلش الكتابة العادية)
const KEY_RE = /^(?:F(?:[1-9]|1[0-2])|[A-Z0-9]|Enter|Space|Insert|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/;
const NAMED_KEYS = ['Enter', 'Space', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

// بترجع الصيغة الموحدة، '' لو فاضي (الاختصار معطّل)، أو null لو غلط
function normalizeCombo(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  let key = parts.pop();
  if (key.length === 1) key = key.toUpperCase();
  else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase();
  else key = NAMED_KEYS.find((k) => k.toLowerCase() === key.toLowerCase()) || key;
  if (!KEY_RE.test(key)) return null;
  const mods = new Set();
  for (const m of parts) {
    const hit = MOD_ORDER.find((x) => x.toLowerCase() === m.toLowerCase());
    if (!hit) return null;
    mods.add(hit);
  }
  const printable = /^[A-Z0-9]$/.test(key) || key === 'Space' || key === 'Enter';
  if (printable && !mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Meta')) return null;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

// كاش قصير (الصفحات كلها بتقراه)؛ بيتمسح أول ما الأدمن يحفظ
let cache = null;
let cacheAt = 0;
const TTL = 15 * 1000;

async function getShortcuts(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  let saved = {};
  try {
    const rows = await query(`SELECT value FROM settings WHERE key = 'shortcuts'`);
    if (rows[0] && rows[0].value) saved = JSON.parse(rows[0].value) || {};
  } catch (err) {
    saved = {};
  }
  const map = { ...DEFAULTS };
  for (const id of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(saved, id)) {
      const n = normalizeCombo(saved[id]);
      if (n !== null) map[id] = n;
    }
  }
  // إعدادات اتحفظت قبل إضافة أسهم المقاسات: لو الكمية كانت على ↑ ↓ (الافتراضي القديم) نرجّعها للافتراضي الجديد (→ ←)
  // عشان ↑ ↓ تروح للمقاسات. ولو مفتاح المقاس الافتراضي متحجوز لإجراء تاني بنسيبه فاضي بدل ما يحصل تعارض.
  const hasSizeKeys = Object.prototype.hasOwnProperty.call(saved, 'pos_size_up') || Object.prototype.hasOwnProperty.call(saved, 'pos_size_down');
  if (!hasSizeKeys) {
    if (saved.pos_qty_up === 'ArrowUp' && saved.pos_qty_down === 'ArrowDown') {
      map.pos_qty_up = DEFAULTS.pos_qty_up;
      map.pos_qty_down = DEFAULTS.pos_qty_down;
    }
    for (const id of ['pos_size_up', 'pos_size_down']) {
      if (Object.keys(map).some((k) => k !== id && map[k] === DEFAULTS[id])) map[id] = '';
    }
  }
  cache = map;
  cacheAt = Date.now();
  return map;
}

async function saveShortcuts(map) {
  await query(
    `INSERT INTO settings (key, value) VALUES ('shortcuts', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(map)]
  );
  cache = null;
}

module.exports = { ACTIONS, BY_ID, NAV_HREFS, DEFAULTS, normalizeCombo, getShortcuts, saveShortcuts };
