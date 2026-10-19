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

module.exports = { digitsOf, waNumber, waLink };
