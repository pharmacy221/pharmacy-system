// public/js/shortcuts.js
// تنفيذ اختصارات الكيبورد اللي الأدمن حددها من الإعدادات.
// - بنعتمد على e.code للحروف والأرقام، فالاختصار بيشتغل حتى لو الكيبورد على العربي.
// - الصفحات بتسجّل إجراءاتها:  Shortcuts.on('pos_clear', () => {...})
(function () {
  var cfg = window.__SC || { keys: {}, nav: {} };
  var handlers = {};
  var api = { keys: cfg.keys || {}, paused: false, handlers: handlers };

  // الضغطة الحالية -> صيغة موحدة زي "Ctrl+Shift+K" / "F9" (أو null لو مفتاح تعديل لوحده)
  function comboOf(e) {
    var k = null, code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) k = code.slice(3);
    else if (/^Digit\d$/.test(code)) k = code.slice(5);
    else if (/^Numpad\d$/.test(code)) k = code.slice(6);
    else if (/^F([1-9]|1[0-2])$/.test(e.key)) k = e.key;
    else if (code === 'Space') k = 'Space';
    else if (e.key === 'Enter' || code === 'NumpadEnter') k = 'Enter';
    else if (['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.key) !== -1) k = e.key;
    if (!k) return null;
    var mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    return mods.concat(k).join('+');
  }

  function isTyping(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  function textLike(t) {
    if (!t || (t.tagName || '').toUpperCase() !== 'INPUT') return false;
    var ty = (t.getAttribute('type') || 'text').toLowerCase();
    return ty === 'text' || ty === 'search';
  }

  function focusSearch() {
    var el = document.getElementById('q') || document.querySelector('input[name="q"]') || document.querySelector('input[type="search"]');
    if (!el) return false;
    el.focus();
    if (el.select) el.select();
  }

  function go(href) {
    // بنفتح الصفحة بس لو الرابط موجود في القائمة (يعني اليوزر مسموح له بيها)
    if (location.pathname === href) return false;
    if (!document.querySelector('#mainNav a[href="' + href + '"]')) return false;
    location.href = href;
  }

  document.addEventListener('keydown', function (e) {
    if (api.paused || e.repeat) return;
    var combo = comboOf(e);
    if (!combo) return;
    var id = null;
    for (var key in api.keys) { if (api.keys[key] && api.keys[key] === combo) { id = key; break; } }
    if (!id) return;
    // وإحنا بنكتب في خانة: بس الاختصارات اللي فيها Ctrl/Alt أو F1-F12 تشتغل
    // والأسهم كمان بتشتغل في خانات النص العادية (الإجراء نفسه بيقرر ينفذ ولا يسيب السهم لحاله)،
    // لكن مش جوه الأرقام/القوائم/النصوص الطويلة عشان السهم هناك له وظيفته
    var arrow = /(?:^|\+)Arrow(?:Up|Down|Left|Right)$/.test(combo);
    if (isTyping(e.target) && !/(?:^|\+)(?:Ctrl|Alt)\+|(?:^|\+)F\d+$/.test(combo) && !(arrow && textLike(e.target))) return;

    var fn = handlers[id];
    if (!fn && id === 'search') fn = focusSearch;
    if (!fn && cfg.nav && cfg.nav[id]) fn = function () { return go(cfg.nav[id]); };
    if (!fn) return;
    var r = fn(e);
    if (r !== false) e.preventDefault();
  }, true);

  api.on = function (id, fn) { handlers[id] = fn; };
  api.comboOf = comboOf;

  // بيعرض الاختصار جنب الأزرار: <kbd data-sc="pos_clear"></kbd> ، وبيخفي الغلاف <span data-sc-wrap="..."> لو مفيش اختصار
  api.paint = function () {
    var sym = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    document.querySelectorAll('[data-sc]').forEach(function (el) {
      el.textContent = (api.keys[el.getAttribute('data-sc')] || '').replace(/Arrow(Up|Down|Left|Right)/, function (m) { return sym[m]; });
    });
    document.querySelectorAll('[data-sc-wrap]').forEach(function (el) {
      el.style.display = api.keys[el.getAttribute('data-sc-wrap')] ? '' : 'none';
    });
  };
  document.addEventListener('DOMContentLoaded', api.paint);

  window.Shortcuts = api;
})();
