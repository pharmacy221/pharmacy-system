// public/js/inputs.js
// منع الكتابة الغلط في خانات الاسم والموبايل (بالكيبورد أو اللصق):
//   data-input="phone"  → أرقام فقط (الأرقام العربية بتتحوّل لإنجليزي) وحد أقصى 11
//   data-input="name"   → ممنوع الأرقام
//   data-input="search" → بحث بالاسم أو الموبايل: لو بدأ برقم يبقى موبايل (أرقام فقط، 11 حد أقصى)، غير كده ممنوع الأرقام
(function () {
  var AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';
  function latin(s) {
    return s.replace(/[٠-٩]/g, function (c) { return AR.indexOf(c); }).replace(/[۰-۹]/g, function (c) { return FA.indexOf(c); });
  }
  function clean(kind, v) {
    v = latin(v);
    if (kind === 'phone') return v.replace(/\D/g, '').slice(0, 11);
    if (kind === 'name') return v.replace(/\d/g, '');
    if (kind === 'search') {
      var t = v.replace(/^\s+/, '');
      return /^\d/.test(t) ? t.replace(/\D/g, '').slice(0, 11) : v.replace(/\d/g, '');
    }
    return v;
  }
  function apply(el) {
    var kind = el.getAttribute('data-input');
    if (!kind) return;
    var next = clean(kind, el.value);
    if (next !== el.value) {
      var pos = el.selectionStart;
      el.value = next;
      try { el.setSelectionRange(Math.min(pos, next.length), Math.min(pos, next.length)); } catch (e) {}
    }
  }
  document.addEventListener('input', function (e) { if (e.target && e.target.getAttribute) apply(e.target); }, true);
  window.PhoneRules = {
    valid: function (v) { return /^01[0125]\d{8}$/.test(latin(String(v || '')).replace(/[\s\-().]/g, '')); },
    MSG: 'الموبايل لازم يكون 11 رقم صحيح (يبدأ بـ 010 أو 011 أو 012 أو 015)'
  };
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('input[data-input="phone"]').forEach(function (el) {
      el.setAttribute('inputmode', 'numeric'); el.setAttribute('maxlength', '11'); el.setAttribute('autocomplete', 'off');
      el.setAttribute('pattern', '01[0125][0-9]{8}'); el.setAttribute('title', 'موبايل مصري من 11 رقم');
    });
  });
})();
