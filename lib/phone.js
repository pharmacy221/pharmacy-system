// lib/phone.js
// أدوات أرقام التليفون: تنظيف الرقم + رابط واتساب (الأرقام المصرية 01xxxxxxxxx بتتحوّل لـ 201xxxxxxxxx).

const digitsOf = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// رقم واتساب دولي بدون + (أو null لو الرقم مش صالح)
function waNumber(phone) {
  let d = digitsOf(phone);
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '20' + d.slice(1);
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

function waLink(phone, text) {
  const n = waNumber(phone);
  if (!n) return null;
  return `https://wa.me/${n}` + (text ? `?text=${encodeURIComponent(text)}` : '');
}

// تحويل الأرقام العربية/الهندية (٠١٢...) لأرقام لاتينية
const toLatinDigits = (s) => String(s == null ? '' : s)
  .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0));

// رقم موبايل مصري صحيح: 11 رقم بالظبط يبدأ بـ 010/011/012/015. بنسمح بمسافات وشرطات في الكتابة بس (بتتشال).
// بيرجّع الرقم نضيف (11 رقم) أو null لو غلط (حروف / طول غلط / مش بيبدأ بكود شبكة مصري).
function normalizeMobile(raw) {
  const t = toLatinDigits(raw).replace(/[\s\-().]/g, '');
  return /^01[0125]\d{8}$/.test(t) ? t : null;
}

// الاسم ممنوع يحتوي على أرقام (لاتيني أو عربي)
const nameHasDigits = (s) => /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(String(s == null ? '' : s));

module.exports = { digitsOf, waNumber, waLink, toLatinDigits, normalizeMobile, nameHasDigits };
