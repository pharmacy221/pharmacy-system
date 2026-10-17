// lib/drug-form.js
// بيحدد "نوع المنتج" من دليل الأدوية (حبة/شريط/علبة، حقنة، بخاخة، شراب، كريم...)
// ويحدد وحدات البيع المسموحة لكل نوع، عشان الكاشير يعرض الوحدة الصح:
//   - أقراص/كبسول:  حبة ← شريط ← علبة
//   - لبوس/أكياس/أمبولات: وحدة ← علبة
//   - حقنة / بخاخة / شراب / كريم ...: وحدة واحدة بإسمها (من غير حبات ولا شرايط)
//
// المخزون بيتسجل دايمًا بوحدة "الوحدة الأساسية" (stock_units):
//   قرص/كبسولة، حقنة، زجاجة، بخاخة، علبة... حسب النوع.

// ---------- تعريف الأنواع ----------
// counted = الصنف ممكن يتباع بالوحدة جوه علبة فيها عدد (قرص/لبوسة/كيس/أمبولة)
const FORMS = {
  tablet:      { label: 'أقراص',        unit: 'حبة',     counted: true,  strip: true  },
  capsule:     { label: 'كبسول',        unit: 'كبسولة',  counted: true,  strip: true  },
  sachet:      { label: 'أكياس',        unit: 'كيس',     counted: true,  strip: false },
  suppository: { label: 'لبوس',         unit: 'لبوسة',   counted: true,  strip: false },
  injection:   { label: 'حقن',          unit: 'حقنة',    counted: true,  strip: false },
  infusion:    { label: 'محلول وريدي',  unit: 'زجاجة',   counted: false },
  syrup:       { label: 'شراب',         unit: 'شراب',    counted: false },
  suspension:  { label: 'معلق',         unit: 'معلق',    counted: false },
  solution:    { label: 'محلول',        unit: 'محلول',   counted: false },
  drops:       { label: 'نقط',          unit: 'قطرة',    counted: false },
  eye_drops:   { label: 'قطرة عين',     unit: 'قطرة',    counted: false },
  ear_drops:   { label: 'قطرة أذن',     unit: 'قطرة',    counted: false },
  eye_oint:    { label: 'مرهم عين',     unit: 'مرهم',    counted: false },
  spray:       { label: 'بخاخ',         unit: 'بخاخة',   counted: false },
  mouthwash:   { label: 'غسول فم',      unit: 'زجاجة',   counted: false },
  douche:      { label: 'غسول مهبلي',   unit: 'زجاجة',   counted: false },
  cream:       { label: 'كريم',         unit: 'كريم',    counted: false },
  ointment:    { label: 'مرهم',         unit: 'مرهم',    counted: false },
  gel:         { label: 'جل',           unit: 'جل',      counted: false },
  lotion:      { label: 'لوشن',         unit: 'لوشن',    counted: false },
  shampoo:     { label: 'شامبو',        unit: 'شامبو',   counted: false },
  soap:        { label: 'صابون',        unit: 'صابونة',  counted: false },
  oil:         { label: 'زيت',          unit: 'زجاجة',   counted: false },
  powder:      { label: 'بودرة',        unit: 'علبة',    counted: false },
  patch:       { label: 'لاصق',         unit: 'علبة',    counted: false },
  inhaler:     { label: 'بخاخ استنشاق', unit: 'بخاخة',   counted: false },
  paste:       { label: 'معجون',        unit: 'معجون',   counted: false },
  milk:        { label: 'حليب/تغذية',   unit: 'علبة',    counted: false },
  other:       { label: 'أخرى',         unit: 'علبة',    counted: false }
};

// لو القرص/الكبسولة معروفش عددهم في الاسم، بنبيعه "علبة" كاملة بس
const BOX_FALLBACK = 'علبة';

// ---------- أدوات استخراج العدد من الاسم ----------
// "(عدد) [كلمات وصف قصيرة: F.C. / SCORED ...] (TABS)"  - بياخد الرقم اللي قبل كلمة الشكل مباشرة
const MOD = '(?!(?:MG|ML|GM|G|MCG|IU|I\\.U|MEQ|KG|CM|MM|L)\\b)[A-Z][A-Z.\\/\\-]*';
const countBefore = (words) =>
  new RegExp(`(\\d+)\\s*(?:${MOD}[\\s.\\-]*){0,4}?(?:${words})\\b`, 'i');

const RE_COUNT = {
  tablet:      countBefore('TABS?|TABLETS?|TAB|TAPS|CAPLETS?|GUMMIES|GUMMY|CHEW(?:ABLE)?S?|LOZENGES?|LOZ|PASTILLES?|DRAGEES?|F\\.?C\\.?T|ODT|ODF|FILMS?|PIECES?|PCS'),
  capsule:     countBefore('CAPS?|CAPSULES?|SOFTGELS?|HGC'),
  sachet:      countBefore('SACHETS?|SACH|STICKS?|ENVELOPES?|FILTER\\s*BAGS?|BAGS?'),
  suppository: countBefore('SUPP(?:OS(?:ITOR(?:Y|IES))?)?S?|OVULES?|PESSAR(?:Y|IES)|PESSARIES|VAG(?:INAL)?\\.?\\s*TABS?'),
  injection:   countBefore('AMPS?|AMPOULES?|VIALS?|SYRINGES?|PENS?|FLEXPENS?|CARTRIDGES?|INJ(?:ECTIONS?)?')
};

// ---------- كلمات تحدد الشكل من الاسم ----------
const W = (s) => new RegExp(`(?:^|[^A-Z])(?:${s})(?![A-Z])`, 'i');
const RE = {
  infusion:  W('I\\.?V\\.?\\s*INF(?:USION)?|INFUSION|I\\.?V\\.?\\s*DRIP|DRIP'),
  injection: W('AMPS?|AMPOULES?|VIALS?|INJ(?:ECTIONS?)?|PREF(?:ILLED)?\\.?\\s*SYRINGES?|PRE-?FILLED|PENS?|FLEXPENS?|FLEXTOUCH|CARTRIDGES?|I\\.?V\\.?|I\\.?M\\.?|S\\.?C\\.?\\s*INJ'),
  spray:     W('SPRAY|SPR'),
  eye_oint:  W('EYE\\s*(?:OINT(?:MENT)?|GEL)|OPHTH?\\.?\\s*OINT(?:MENT)?'),
  eye_drops: W('EYE\\s*(?:DROPS?|DPS|SUSP|SOL(?:UTION)?)|OPHTH?\\.?\\s*(?:DROPS?|SOL)|CONTACT\\s*LENS'),
  ear_drops: W('EAR\\s*(?:DROPS?|DPS|SOL(?:UTION)?)|OTIC'),
  drops:     W('DROPS?|DPS|GTT'),
  mouthwash: W('MOUTH\\s*WASH|MOUTHRINSE|MOUTH\\s*RINSE|GARGLE'),
  douche:    W('DOUCH(?:E|US|ES)|DOUSH|VAG(?:INAL)?\\.?\\s*(?:WASH|DOUCHE)|INTIMATE\\s*WASH'),
  suppository: W('SUPP(?:OS(?:ITOR(?:Y|IES))?)?S?|OVULES?|PESSAR(?:Y|IES)|PESSARIES'),
  sachet:    W('SACHETS?|SACH|STICKS?|FILTER\\s*BAGS?|GRANULES?(?!\\s*FOR\\s*(?:ORAL\\s*)?(?:SUSP|SYRUP|SOL))'),
  suspension:W('SUSP(?:ENSION)?|SUPS|ORAL\\s*SUSP|G(?:R|RANULES)\\.?\\s*FOR\\s*(?:ORAL\\s*)?(?:SUSP|SYRUP|SOL)|DRY\\s*SYRUP'),
  syrup:     W('SYRUP|SYR|ELIXIR|LINCTUS|EMULSION|COUGH\\s*MIXTURE|MIXTURE|JUICE|TONIC(?!\\s*(?:HAIR|SKIN))'),
  solution:  W('SOL(?:UTION|N)?|ANTISEPTIC|LIQUID|FLUID|IRRIGATION|WATER'),
  capsule:   W('CAPS?|CAPSULES?|SOFTGELS?|HGC'),
  tablet:    W('TABS?|TABLETS?|TAPS|CAPLETS?|GUMMIES|GUMMY|JELLY\\s*CANDY|CHEW(?:ABLE)?S?|LOZENGES?|PASTILLES?|DRAGEES?|F\\.?C\\.?\\s*T|FCT|ODT|ODF|FILMS?|GUM'),
  shampoo:   W('SHAMPOO|SHAMPO|CONDITIONER'),
  soap:      W('SOAP|CLEANSING\\s*BAR|SYNDET'),
  lotion:    W('LOTION|LOTN|TONER|MICELLAR|CLEANSER|WASH|FOAM|MOUSSE|MILK'),
  gel:       W('GEL|SERUM|PASTE|PAINT'),
  cream:     W('CREAM|CRM|BALM|BUTTER|MASK|SCRUB|SUNSCREEN|SUN\\s*BLOCK|SUNBLOCK|MOISTURI[SZ]ER|LIP\\s*(?:CARE|BALM)|ROLL[\\s-]*ON|STICK|COMPACT|FLUID|DEO'),
  ointment:  W('OINT(?:MENT)?|OINT\\.?'),
  oil:       W('OIL|HAIR\\s*TONIC'),
  powder:    W('POWDER|TALC'),
  patch:     W('PLASTERS?|PATCH(?:ES)?|BANDAGES?|DRESSING'),
  inhaler:   W('INHALERS?|TURBUHALER|EVOHALER|ACCUHALER|HANDIHALER|METERED\\s*DOSE|MDI|HFA|ACTUATIONS?|\\d+\\s*DOSES|NEBULI[SZ]ER|RESPIMAT|DISKUS'),
  paste:     W('TOOTH\\s*PASTE|TOOTHPASTE|DENTAL\\s*(?:PASTE|GEL)'),
  milk:      W('MILK|FORMULA|INFANT')
};

const test = (re, s) => re.test(s);

// ---------- التصنيف ----------
function detectKind(d) {
  const name = String(d.name_en || d.name || '').replace(/\s+/g, ' ').trim();
  const route = d.route || 'UNKNOWN';
  const solidAllowed = !['TOPICAL', 'SOAP', 'SPRAY', 'EYE', 'EAR', 'MOUTH', 'VAGINAL', 'RECTAL', 'INJECTION'].includes(route);

  // 1) الحقن: محاليل التسريب (كيس/زجاجة) لوحدها، وأي فيال/أمبولة تفضل "حقنة"
  if (route === 'INJECTION') {
    const isVialLike = /\b(AMPS?|AMPOULES?|VIALS?|SYRINGES?|PENS?|CARTRIDGES?)\b/i.test(name);
    return !isVialLike && test(RE.infusion, name) ? 'infusion' : 'injection';
  }

  if (route === 'UNKNOWN' && test(RE.infusion, name) && !/\b(AMPS?|VIALS?)\b/i.test(name)) return 'infusion';
  if (test(RE.inhaler, name)) return 'inhaler';
  if (route === 'SPRAY' || test(RE.spray, name)) {
    if (!test(RE.injection, name) || route === 'SPRAY') return 'spray';
  }
  if (test(RE.paste, name)) return 'paste';
  if (test(RE.mouthwash, name) || (route === 'MOUTH' && !test(RE.spray, name))) return 'mouthwash';
  if (test(RE.eye_oint, name)) return 'eye_oint';
  if (test(RE.eye_drops, name) || (route === 'EYE' && test(RE.drops, name))) return 'eye_drops';
  if (route === 'EYE') return test(RE.ointment, name) || test(RE.gel, name) ? 'eye_oint' : 'eye_drops';
  if (route === 'EAR' && (test(RE.ear_drops, name) || test(RE.drops, name) || test(RE.solution, name))) return 'ear_drops';
  if (test(RE.ear_drops, name)) return 'ear_drops';

  if (route === 'RECTAL' || route === 'VAGINAL' || test(RE.suppository, name)) {
    if (test(RE.douche, name)) return 'douche';
    if (route === 'VAGINAL' && !test(RE.suppository, name) && !/TAB(?:S|LETS?)?\b/i.test(name)) {
      if (test(RE.cream, name)) return 'cream';
      if (test(RE.gel, name)) return 'gel';
      if (test(RE.ointment, name)) return 'ointment';
      if (test(RE.lotion, name)) return 'douche';
    }
    if (test(RE.suppository, name) || route === 'RECTAL') return 'suppository';
    if (/TAB(?:S|LETS?)?\b/i.test(name)) return 'tablet';
  }

  if (test(RE.douche, name)) return 'douche';

  // أمبولات/فيالات حتى لو الـ route مش INJECTION (UNKNOWN)
  if (test(RE.injection, name) && !/\b(ORAL|DRINKABLE|SYRUP|TABS?|CAPS?)\b/i.test(name)) {
    if (/(AMPS?|AMPOULES?|VIALS?|INJ|SYRINGES?|PENS?|FLEXPENS?|FLEXTOUCH|CARTRIDGES?)\b/i.test(name)) return 'injection';
  }

  // سوائل الفم
  if (route === 'ORAL.LIQUID' || (route === 'UNKNOWN' && /\d\s*ML\b/i.test(name))) {
    const hasSolid = test(RE.tablet, name) || test(RE.capsule, name);
    if (!hasSolid || /SYRUP|SUSP/i.test(name)) {
      if (test(RE.suspension, name)) return 'suspension';
      if (test(RE.drops, name)) return 'drops';
      if (test(RE.syrup, name)) return 'syrup';
      if (test(RE.solution, name)) return 'solution';
      if (route === 'ORAL.LIQUID') return 'syrup';
    }
  }

  // أكياس / فوار
  if (route === 'EFF' || test(RE.sachet, name)) {
    if (test(RE.suspension, name)) return 'suspension';
    if (test(RE.tablet, name) && route === 'EFF') return 'tablet';
    if (test(RE.sachet, name)) return 'sachet';
    if (route === 'EFF') return test(RE.powder, name) ? 'powder' : 'sachet';
  }

  // صلب
  if (solidAllowed && test(RE.capsule, name)) return 'capsule';
  if (solidAllowed && test(RE.tablet, name)) return 'tablet';
  if (route === 'ORAL.SOLID') return 'tablet';

  // حليب أطفال/تغذية (علب جرام)
  if (test(RE.milk, name) && /\d+\s*(?:GM|G|GRAM|KG)\b/i.test(name) && !/LOTION|CLEANS|BODY|FACE|MAKE|WASH|CREAM|BATH/i.test(name)) return 'milk';

  // موضعي/عناية
  if (test(RE.suspension, name)) return 'suspension';
  if (test(RE.drops, name)) return 'drops';
  if (test(RE.shampoo, name)) return 'shampoo';
  if (test(RE.soap, name) || route === 'SOAP') return 'soap';
  if (test(RE.ointment, name)) return 'ointment';
  if (test(RE.cream, name)) return 'cream';
  if (test(RE.gel, name)) return 'gel';
  if (test(RE.lotion, name)) return 'lotion';
  if (test(RE.oil, name)) return 'oil';
  if (test(RE.powder, name)) return 'powder';
  if (test(RE.patch, name)) return 'patch';
  if (test(RE.syrup, name)) return 'syrup';
  if (test(RE.solution, name)) return 'solution';
  if (route === 'TOPICAL') return 'cream';
  return 'other';
}

// حجم الشريط التقليدي حسب عدد الحبات في العلبة (تقدير؛ تقدر تعدّله من صفحة الأصناف)
function guessStripLayout(total) {
  if (!total || total < 1) return null;
  if (total <= 15) return { ups: total, spb: 1 };
  for (const s of [10, 14, 15, 12, 7, 8, 6, 5, 4]) {
    if (total % s === 0) return { ups: s, spb: total / s };
  }
  return { ups: total, spb: 1 };
}

function extractCount(kind, name) {
  const re = RE_COUNT[kind];
  if (!re) return null;
  const m = re.exec(name);
  const n = m ? parseInt(m[1], 10) : null;
  return n && n >= 1 && n <= 1000 ? n : null;
}

// الدالة الأساسية: بتاخد صف من drug_reference وترجع كل بيانات النوع والتعبئة
function classifyDrug(d) {
  const name = String(d.name_en || d.name || '');
  const kind = detectKind(d);
  const f = FORMS[kind];

  let unitsPerStrip = 1;
  let stripsPerBox = 1;

  if (f.counted) {
    const n = extractCount(kind, name);
    if (n) {
      if (f.strip) {
        const lay = guessStripLayout(n);
        unitsPerStrip = lay.ups;
        stripsPerBox = lay.spb;
      } else {
        unitsPerStrip = n; // علبة فيها n وحدة (لبوس/أكياس/أمبولات) من غير شرايط
        stripsPerBox = 1;
      }
    }
  }

  const multi = unitsPerStrip > 1 || stripsPerBox > 1;
  return {
    kind,
    dosageForm: f.label,
    unitsPerStrip,
    stripsPerBox,
    // لو الصنف ملوش تعبئة بالعدد: وحدة واحدة بس
    single: !multi,
    countable: !!f.counted,
    // القديم (للتوافق مع drug-lookup)
    label: !multi ? singleLabel(kind) : null
  };
}

// اسم الوحدة لما يكون الصنف وحدة واحدة
function singleLabel(kind) {
  const f = FORMS[kind] || FORMS.other;
  return f.counted && !['injection'].includes(kind) ? BOX_FALLBACK : f.unit;
}

// وحدات البيع المتاحة لصنف موجود في جدول medicines + أسماءها
// بترجع: { levels:[{key,label,qtyUnits}], defaultLevel, single }
//   key = unit | strip | box  (نفس القيم المسموحة في sale_items.sale_unit)
function saleLevels(m) {
  const ups = Math.max(parseInt(m.units_per_strip) || 1, 1);
  const spb = Math.max(parseInt(m.strips_per_box) || 1, 1);
  const f = m.form_kind ? FORMS[m.form_kind] : null;

  // أصناف قديمة (من غير نوع): نفس السلوك القديم، حبة / شريط / علبة
  if (!f) {
    const levels = [{ key: 'unit', label: 'حبة', qty: 1 }];
    if (ups > 1) levels.push({ key: 'strip', label: 'شريط', qty: ups });
    if (ups * spb > 1 || m.sale_price_box) levels.push({ key: 'box', label: 'علبة', qty: ups * spb });
    return { levels, defaultLevel: 'unit', single: levels.length === 1, kind: null, formLabel: m.dosage_form || null };
  }

  if (ups === 1 && spb === 1) {
    // وحدة واحدة باسمها: حقنة / شراب / بخاخة / علبة...
    return { levels: [{ key: 'unit', label: singleLabel(m.form_kind), qty: 1 }], defaultLevel: 'unit', single: true, kind: m.form_kind, formLabel: f.label };
  }

  const levels = [{ key: 'unit', label: f.unit, qty: 1 }];
  if (f.strip && ups > 1 && spb > 1) levels.push({ key: 'strip', label: 'شريط', qty: ups });
  levels.push({ key: 'box', label: 'علبة', qty: ups * spb });
  // الأقراص: الافتراضي شريط لو موجود، وإلا علبة. الباقي: الوحدة
  const def = levels.find((l) => l.key === 'strip') ? 'strip' : (f.strip ? 'box' : 'unit');
  return { levels, defaultLevel: def, single: false, kind: m.form_kind, formLabel: f.label };
}

// لتسمية الوحدة في الفواتير/المرتجعات: (صنف، sale_unit) -> "حقنة" / "شريط" ...
function unitLabel(m, saleUnit) {
  const { levels } = saleLevels(m);
  const l = levels.find((x) => x.key === saleUnit);
  if (l) return l.label;
  return ({ unit: 'حبة', strip: 'شريط', box: 'علبة' })[saleUnit] || saleUnit;
}

module.exports = { FORMS, classifyDrug, detectKind, saleLevels, unitLabel, singleLabel };
