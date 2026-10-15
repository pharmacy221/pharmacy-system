// lib/drug-form.js
// بيحدد شكل الدواء (شريط/زجاجة/علبة) من بيانات دليل الأدوية، عشان نعرض الوحدة الصح
// ومنطلبش "عدد الحبات والشرائط" لو الصنف شراب أو مستحضر موضعي.
//   strip  = أقراص/كبسول/أكياس... (حبة × شريط × علبة)
//   bottle = شراب/معلق/قطرة/محلول (وحدة واحدة = زجاجة)
//   pack   = كريم/بخاخ/نقط عين/حقن... (وحدة واحدة = علبة)

const SOLID_NAME = /\b(TABS?|TABLETS?|CAPS?|CAPSULES?|SACHETS?|SUPP|SUPPOSITOR(Y|IES)|AMP|AMPS|AMPOULES?|VIALS?|LOZENGES?|CHEWABLE)\b|\bF\.?C\.?\s*T/i;
const LIQUID_NAME = /\b(SYRUP|SYR|SUSP|SUSPENSION|ELIXIR|DROPS?|SOLUTION|SOL|EMULSION)\b|\d\s*ML\b/i;
const PACK_ROUTES = new Set(['TOPICAL', 'SPRAY', 'EYE', 'EAR', 'MOUTH', 'SOAP', 'INJECTION']);

function classifyDrug(d) {
  const name = `${d.name_en || ''}`;
  const route = d.route || '';
  const solidName = SOLID_NAME.test(name);

  let kind = 'strip';
  if (!solidName && (route === 'ORAL.LIQUID' || (route === 'UNKNOWN' && LIQUID_NAME.test(name)))) kind = 'bottle';
  else if (route === 'ORAL.LIQUID' && solidName && /\bSYRUP\b/i.test(name)) kind = 'bottle'; // اسم فيه كلمة تشبه tab لكنه شراب فعلًا
  else if (PACK_ROUTES.has(route)) kind = 'pack';
  else if (!solidName && /\bSYRUP\b/i.test(name)) kind = 'bottle';

  const label = kind === 'bottle' ? 'زجاجة' : kind === 'pack' ? 'علبة' : null;

  let dosageForm = null;
  if (kind === 'bottle') {
    dosageForm = /DROPS?/i.test(name) ? 'قطرة' : /SUSP/i.test(name) ? 'معلق' : /SOLUTION|\bSOL\b/i.test(name) ? 'محلول' : 'شراب';
  } else if (kind === 'pack') {
    dosageForm = { TOPICAL: 'موضعي', SPRAY: 'بخاخ', EYE: 'نقط/مرهم عين', EAR: 'نقط أذن', MOUTH: 'فم', SOAP: 'صابون', INJECTION: 'حقن' }[route] || null;
  }
  return { kind, label, dosageForm, single: kind !== 'strip' };
}

module.exports = { classifyDrug };
