/* QM.admin core: بناء DOM آمن (لا innerHTML أبداً للبيانات)، حوارات، نماذج، جداول، تنسيق. */
(function () {
  var A = QM.admin = QM.admin || {};
  var i18n = QM.i18n;
  A.t = function (k, p) { return i18n.t(k, p); };
  A.api = QM.createApi({});
  A.state = { me: null, csrfOk: false };

  /* h('div', {class:'x', onclick:fn, 'aria-label':'..'}, child, [children], 'text') — النصوص تُدرج كـ text nodes فقط */
  A.h = function h(tag, attrs) {
    var el = document.createElement(tag);
    var i = 2;
    if (attrs && (typeof attrs === 'string' || typeof attrs === 'number' || attrs instanceof Node || Array.isArray(attrs))) { i = 1; attrs = null; }
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled' || k === 'required' || k === 'multiple' || k === 'selected' || k === 'hidden') el[k] = !!v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (function add(list) {
      for (var j = 0; j < list.length; j++) {
        var c = list[j];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) add(c);
        else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    })(Array.prototype.slice.call(arguments, i));
    return el;
  };
  var h = A.h;
  A.icon = function (name, size) {
    var span = document.createElement('span'); span.setAttribute('aria-hidden', 'true');
    span.innerHTML = QM.icon ? QM.icon(name, { size: size || 18 }) : ''; // أيقونات ثابتة من حزمة shared فقط
    return span;
  };
  A.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  A.name = function (o) { return i18n.pick(o && o.nameAr !== undefined ? { name_ar: o.nameAr, name_en: o.nameEn } : o); };
  A.num = function (n) { return n == null ? '—' : i18n.fmtNumber(n); };
  A.min = function (n) { return n == null ? '—' : A.t('u.min', { n: i18n.fmtNumber(n) }); };
  A.dt = function (iso, tz) { return iso ? i18n.fmtDate(iso, tz) + ' ' + i18n.fmtTime(iso, tz) : '—'; };
  A.today = function () { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  A.err = function (e) { return i18n.errorMessage(e); };
  A.toast = function (msg, kind) { QM.toast(msg, kind); };
  A.fail = function (e) { A.toast(A.err(e), 'error'); };

  /* زر بحالة انشغال: يمنع النقر المزدوج ويعرض الأخطاء */
  A.btn = function (label, opts) {
    opts = opts || {};
    var b = h('button', { type: opts.type || 'button', class: 'qm-btn' + (opts.kind ? ' qm-btn--' + opts.kind : '') + (opts.sm ? ' qm-btn--sm' : ''), 'aria-label': opts.aria }, opts.icon ? A.icon(opts.icon) : null, label);
    if (opts.onClick) b.addEventListener('click', async function () {
      if (b.getAttribute('aria-busy') === 'true') return;
      b.setAttribute('aria-busy', 'true'); b.disabled = true;
      try { await opts.onClick(b); } catch (e) { A.fail(e); } finally { b.removeAttribute('aria-busy'); b.disabled = false; }
    });
    return b;
  };

  /* حوار: body عقدة DOM؛ buttons: [{label, kind, onClick(ctx)→ true للإغلاق}]. يرجع {close} */
  A.dialog = function (title, body, buttons, opts) {
    opts = opts || {};
    var prev = document.activeElement;
    var back = h('div', { class: 'qm-modal-backdrop' });
    var tid = 'dlg-' + Math.random().toString(36).slice(2, 8);
    var errBox = h('div', { class: 'qm-error-text', role: 'alert', hidden: true });
    var actions = h('div', { class: 'qm-modal__actions' });
    var box = h('div', { class: 'qm-modal adm-dialog' + (opts.wide ? ' adm-dialog--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
      h('div', { class: 'qm-modal__title', id: tid }, title), h('div', { class: 'qm-modal__body adm-dialog__body' }, body), errBox, actions);
    var ctx = {
      close: close, box: box,
      error: function (m) { errBox.textContent = m || ''; errBox.hidden = !m; }
    };
    function close() { document.removeEventListener('keydown', onKey, true); back.remove(); if (prev && prev.focus) try { prev.focus(); } catch (e) {} if (opts.onClose) opts.onClose(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        var f = box.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])'); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    (buttons || []).forEach(function (bd) {
      actions.appendChild(A.btn(bd.label, { kind: bd.kind, type: 'button', onClick: async function () {
        ctx.error('');
        var res;
        try { res = bd.onClick ? await bd.onClick(ctx) : true; } catch (e) { ctx.error(A.err(e)); return; }
        if (res === true) close();
      } }));
    });
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', function (e) { if (e.target === back && !opts.lock) close(); });
    back.appendChild(box); document.body.appendChild(back);
    var f0 = box.querySelector('input:not([type=hidden]),select,textarea') || actions.lastChild; if (f0 && f0.focus) f0.focus();
    return ctx;
  };
  A.confirm = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      A.dialog(opts.title || A.t('common.confirm'), h('p', null, message), [
        { label: A.t('f.cancel'), kind: 'secondary', onClick: function () { done = true; resolve(false); return true; } },
        { label: opts.okLabel || A.t('common.confirm'), kind: opts.danger ? 'danger' : null, onClick: function () { done = true; resolve(true); return true; } }
      ], { onClose: function () { if (!done) resolve(false); } });
    });
  };

  /* حقول النماذج. كل دالة ترجع {el, get(), set(v)} */
  function wrap(label, control, hint, id) {
    return h('div', { class: 'qm-field' }, h('label', { class: 'qm-label', for: id }, label), control, hint ? h('div', { class: 'qm-hint' }, hint) : null);
  }
  var uid = 0;
  A.f = {
    text: function (label, o) { o = o || {}; var id = 'f' + (++uid); var inp = h('input', { id: id, class: 'qm-input', type: o.type || 'text', value: o.value == null ? '' : o.value, maxlength: o.max, required: o.required, autocomplete: o.autocomplete || 'off', dir: o.dir, placeholder: o.placeholder, min: o.min, step: o.step, 'aria-required': o.required ? 'true' : null });
      return { el: wrap(label, inp, o.hint, id), input: inp, get: function () { return inp.value; }, set: function (v) { inp.value = v == null ? '' : v; } }; },
    number: function (label, o) { o = o || {}; var f = A.f.text(label, Object.assign({}, o, { type: 'number' })); f.get = function () { return f.input.value === '' ? null : Number(f.input.value); }; return f; },
    area: function (label, o) { o = o || {}; var id = 'f' + (++uid); var ta = h('textarea', { id: id, class: 'qm-input adm-area', rows: o.rows || 3, maxlength: o.max }, o.value || '');
      return { el: wrap(label, ta, o.hint, id), input: ta, get: function () { return ta.value; }, set: function (v) { ta.value = v || ''; } }; },
    select: function (label, options, o) { o = o || {}; var id = 'f' + (++uid);
      var sel = h('select', { id: id, class: 'qm-input' }, options.map(function (op) { return h('option', { value: String(op.value), selected: String(op.value) === String(o.value) }, op.label); }));
      return { el: wrap(label, sel, o.hint, id), input: sel, get: function () { return sel.value; }, set: function (v) { sel.value = v == null ? '' : String(v); } }; },
    check: function (label, o) { o = o || {}; var id = 'f' + (++uid); var cb = h('input', { id: id, type: 'checkbox', checked: !!o.value });
      return { el: h('label', { class: 'adm-check', for: id }, cb, h('span', null, label)), input: cb, get: function () { return cb.checked; }, set: function (v) { cb.checked = !!v; } }; },
    checks: function (label, options, selected, o) { o = o || {}; var set = {}; (selected || []).forEach(function (v) { set[v] = true; });
      var boxes = options.map(function (op) { var id = 'f' + (++uid); var cb = h('input', { id: id, type: 'checkbox', value: String(op.value), checked: !!set[op.value] }); return { cb: cb, el: h('label', { class: 'adm-check', for: id }, cb, h('span', null, op.label)) }; });
      var group = h('div', { class: 'adm-checks', role: 'group', 'aria-label': label }, boxes.length ? boxes.map(function (b) { return b.el; }) : h('span', { class: 'qm-hint' }, o.empty || A.t('f.none')));
      return { el: h('div', { class: 'qm-field' }, h('div', { class: 'qm-label' }, label), group), get: function () { return boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return Number(b.cb.value); }); } }; },
    datetime: function (label, o) { o = o || {}; var f = A.f.text(label, { type: 'datetime-local', hint: o.hint, dir: 'ltr' });
      /* محلي ↔ ISO UTC */
      f.set = function (iso) { if (!iso) { f.input.value = ''; return; } var d = new Date(iso); var p = function (n) { return String(n).padStart(2, '0'); };
        f.input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
      f.get = function () { return f.input.value ? new Date(f.input.value).toISOString() : null; };
      if (o.value) f.set(o.value); return f; }
  };

  /* جدول. columns: [{label, render(row)|key, class}] */
  A.table = function (columns, rows, o) {
    o = o || {};
    if (!rows.length) return h('p', { class: 'adm-empty' }, o.empty || A.t('f.empty'));
    var head = h('tr', null, columns.map(function (c) { return h('th', { scope: 'col', class: c.class }, c.label); }));
    var body = rows.map(function (r) {
      return h('tr', o.rowAttrs ? o.rowAttrs(r) : null, columns.map(function (c) {
        var v = typeof c.render === 'function' ? c.render(r) : r[c.key];
        return h('td', { class: c.class, 'data-label': c.label }, v == null ? '—' : v);
      }));
    });
    return h('div', { class: 'adm-table-wrap' }, h('table', { class: 'adm-table' }, h('thead', null, head), h('tbody', null, body)));
  };
  A.badge = function (text, kind) { return h('span', { class: 'qm-badge qm-badge--' + (kind || 'completed') }, text); };
  A.activeBadge = function (on) { return A.badge(on ? A.t('f.active') : A.t('f.inactive'), on ? 'serving' : 'cancelled'); };
  A.card = function (title, body, actions) { return h('section', { class: 'qm-card adm-section' }, (title || actions) ? h('div', { class: 'adm-section__head' }, title ? h('h2', { class: 'adm-h2' }, title) : null, actions ? h('div', { class: 'adm-actions' }, actions) : null) : null, body); };
  A.pageHead = function (title, actions) { return h('div', { class: 'adm-pagehead' }, h('h1', { class: 'adm-h1' }, title), actions ? h('div', { class: 'adm-actions' }, actions) : null); };
  A.isAdmin = function () { return A.state.me && A.state.me.role === 'admin'; };
  A.loading = function () { return h('p', { class: 'adm-loading' }, h('span', { class: 'qm-spinner' }), ' ', A.t('common.loading')); };
  A.errorBox = function (e, retry) { return h('div', { class: 'qm-banner qm-banner--error', role: 'alert' }, h('div', { class: 'qm-banner__body' }, A.err(e)), retry ? A.btn(A.t('common.retry'), { sm: true, kind: 'secondary', onClick: retry }) : null); };

  /* رفع multipart مع CSRF (api.js يرسل JSON فقط) */
  A.upload = async function (method, path, formData) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var token = await A.api.getCsrf(attempt > 0);
      var res = await fetch(path, { method: method, credentials: 'same-origin', headers: { 'X-CSRF-Token': token, Accept: 'application/json' }, body: formData });
      var json = null; try { json = await res.json(); } catch (e) { json = null; }
      if (json && json.ok === true) return json.data;
      var code = json && json.error && json.error.code;
      if (res.status === 403 && attempt === 0 && (code === 'FORBIDDEN' || code === 'CSRF')) { A.api.resetCsrf(); continue; }
      if (res.status === 401) { A.api.request('GET', '/api/auth/me', {}).catch(function () {}); }
      throw new QM.ApiError(code || 'UNKNOWN', json && json.error && json.error.message, res.status, json && json.error && json.error.details);
    }
  };
})();
