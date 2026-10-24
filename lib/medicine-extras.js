// lib/medicine-extras.js
// حقول إضافية للصنف: كلمة الاختصار (للكاشير) + المقاس (سرنجات/حفاظات/...).
const { BusinessError } = require('./errors');

// كلمة الاختصار: كلمة واحدة من غير مسافات (حروف/أرقام/شرطة)، لحد 40 حرف. فاضية = من غير اختصار.
function cleanShortcut(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/\s/.test(s)) throw new BusinessError('كلمة الاختصار لازم تكون كلمة واحدة من غير مسافات');
  if (s.length > 40) throw new BusinessError('كلمة الاختصار طويلة (الحد الأقصى 40 حرف)');
  return s;
}

// المقاس: المجموعة (مثلاً "سرنجات") + اسم المقاس ("5 مل") + الترتيب (الأصغر رقم أصغر). كلها اختيارية.
// لو المجموعة فاضية بنمسح باقي بيانات المقاس.
function cleanSize(b) {
  const group = String(b.size_group == null ? '' : b.size_group).trim().slice(0, 80) || null;
  if (!group) return { group: null, label: null, order: null };
  const label = String(b.size_label == null ? '' : b.size_label).trim().slice(0, 40) || null;
  let order = null;
  if (b.size_order !== undefined && String(b.size_order).trim() !== '') {
    order = Number(b.size_order);
    if (!Number.isFinite(order) || Math.abs(order) > 99999999) throw new BusinessError('ترتيب المقاس لازم يكون رقم');
  }
  return { group, label, order };
}

// رسالة خطأ التكرار المناسبة حسب الـ constraint
function duplicateMessage(err) {
  return err && /shortcut/i.test(String(err.constraint || '')) ? 'كلمة الاختصار دي مستخدمة في صنف تاني' : 'الباركود أو السريال ده مستخدم في صنف تاني بالفعل';
}

module.exports = { cleanShortcut, cleanSize, duplicateMessage };
