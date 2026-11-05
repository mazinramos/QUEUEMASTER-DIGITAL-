/* Small DOM helpers shared by patient + staff: html escaping, toasts, modal, language switch, clipboard. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; Object.keys(api).forEach(function (k) { root.QM[k] = api[k]; }); }
})(typeof self !== 'undefined' ? self : this, function (root) {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, el) { return (el || document).querySelector(sel); }

  var toastBox = null;
  function toast(msg, kind, ms) {
    if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'qm-toasts'; toastBox.setAttribute('role', 'status'); toastBox.setAttribute('aria-live', 'polite'); document.body.appendChild(toastBox); }
    var el = document.createElement('div'); el.className = 'qm-toast' + (kind ? ' qm-toast--' + kind : ''); el.textContent = msg;
    toastBox.appendChild(el);
    setTimeout(function () { el.remove(); }, ms || (kind === 'error' ? 6000 : 3500));
  }

  /* modal({ title, bodyHtml, actions:[{label, kind, value, keepOpen}], onOpen }) -> Promise<value|null> (null on dismiss) */
  function modal(o) {
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var back = document.createElement('div'); back.className = 'qm-modal-backdrop';
      var box = document.createElement('div'); box.className = 'qm-modal'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      var tid = 'qm-modal-t-' + Math.random().toString(36).slice(2, 7); box.setAttribute('aria-labelledby', tid);
      box.innerHTML = '<div class="qm-modal__title" id="' + tid + '">' + esc(o.title || '') + '</div><div class="qm-modal__body">' + (o.bodyHtml || '') + '</div><div class="qm-modal__actions"></div>';
      var actions = box.querySelector('.qm-modal__actions');
      function close(v) { document.removeEventListener('keydown', onKey, true); back.remove(); if (prev && prev.focus) try { prev.focus(); } catch (e) {} resolve(v); }
      (o.actions || []).forEach(function (a) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'qm-btn' + (a.kind ? ' qm-btn--' + a.kind : '');
        b.textContent = a.label; b.addEventListener('click', function () {
          if (a.validate && !a.validate(box)) return;
          close(a.collect ? a.collect(box) : a.value);
        }); actions.appendChild(b);
      });
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key === 'Tab') { var f = box.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'); if (!f.length) return; var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('mousedown', function (e) { if (e.target === back && !o.modalLock) close(null); });
      back.appendChild(box); document.body.appendChild(back);
      if (o.onOpen) o.onOpen(box, close);
      var focusEl = box.querySelector('[autofocus]') || box.querySelector('input,select,textarea') || actions.lastChild; if (focusEl) focusEl.focus();
    });
  }

  function bindLangSwitch(i18n) {
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.qm-lang button[data-lang]'); if (b) i18n.setLang(b.getAttribute('data-lang'));
    });
  }

  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
    try { var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;inset-block-start:-1000px;opacity:0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
  }
  return { esc: esc, $: $, toast: toast, modal: modal, bindLangSwitch: bindLangSwitch, copyText: copyText };
});
