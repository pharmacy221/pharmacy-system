// public/js/scanner.js
// قارئ الباركود (USB / بلوتوث بيتصرف ككيبورد): بيكتب الأرقام بسرعة كبيرة وبعدها Enter.
// بيشتغل في أي مكان في الصفحة حتى لو مفيش خانة بحث متفتحة:
//   1) لو الصفحة عرّفت window.onBarcodeScan(code) بيناديها (ولو رجّعت false بيكمل للطريقة 2)
//   2) غير كده بيكتب الكود في أول خانة عليها data-scan-target ويضغط Enter فيها
// الكتابة العادية باليد (أبطأ من كده) مش بتتأثر. الكود اللي اتكتب في الخانة المتفتحة بيتشال منها.
(function () {
  if (window.__scannerLoaded) return;
  window.__scannerLoaded = true;
  var MAX_GAP = 80;      // أقصى فاصل (ms) بين حرفين من القارئ
  var MIN_LEN = 4;       // أقل طول للباركود
  var buf = '', last = 0;

  function cleanActive(code) {
    var el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.readOnly || el.disabled) return;
    if (typeof el.value === 'string' && el.value.slice(-code.length) === code) {
      el.value = el.value.slice(0, el.value.length - code.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function dispatch(code) {
    cleanActive(code);
    if (typeof window.onBarcodeScan === 'function') {
      if (window.onBarcodeScan(code) !== false) return true;
    }
    var t = document.querySelector('[data-scan-target]');
    if (!t) return false;
    t.value = code;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.focus();
    var form = t.form;
    var ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    var notPrevented = t.dispatchEvent(ev);
    if (notPrevented && form && t.getAttribute('data-scan-submit') !== 'no') {
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    }
    return true;
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    var now = Date.now();
    if (e.key === 'Enter') {
      var code = buf; buf = '';
      if (code.length >= MIN_LEN && /^[0-9A-Za-z\-_.\/]+$/.test(code)) {
        if (dispatch(code)) { e.preventDefault(); e.stopPropagation(); }
      }
      return;
    }
    if (e.key.length !== 1) return;
    if (now - last > MAX_GAP) buf = '';
    buf += e.key; last = now;
  }, true);
})();
