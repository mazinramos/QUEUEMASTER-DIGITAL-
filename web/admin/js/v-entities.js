/* العيادة، الخدمات، الشبابيك، الموظفون، سجل التدقيق (عقود ح1: JSON بحقول camelCase). التعديل لمدير النظام فقط. */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var api = A.api;
  A.views = A.views || {};
  var roleLabel = function (r) { return t('a.role.' + r); };

  /* ---------- العيادة ---------- */
  A.views.clinic = { role: 'manager', render: async function (root) {
    root.appendChild(A.pageHead(t('cl.title')));
    var body = h('div'); root.appendChild(body); body.appendChild(A.loading());
    var c;
    try { c = await api.get('/api/admin/clinic'); } catch (e) { A.clear(body); body.appendChild(A.errorBox(e)); return; }
    A.clear(body);
    var admin = A.isAdmin();
    var tzs = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['Africa/Cairo', 'Africa/Khartoum', 'UTC']);
    var f = {
      nameAr: A.f.text(t('f.name_ar'), { value: c.nameAr, required: true, max: 120 }), nameEn: A.f.text(t('f.name_en'), { value: c.nameEn, max: 120, dir: 'ltr' }),
      address: A.f.text(t('cl.address'), { value: c.address, max: 300 }), phone: A.f.text(t('cl.phone'), { value: c.phone, max: 40, dir: 'ltr' }),
      email: A.f.text(t('cl.email'), { value: c.email, max: 120, type: 'email', dir: 'ltr' }),
      timezone: A.f.select(t('cl.tz'), (tzs.indexOf(c.timezone) < 0 ? [c.timezone] : []).concat(tzs).map(function (z) { return { value: z, label: z }; }), { value: c.timezone }),
      defaultLanguage: A.f.select(t('cl.lang'), [{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }], { value: c.defaultLanguage })
    };
    var form = h('form', { class: 'adm-form', novalidate: true }, Object.keys(f).map(function (k) { return f[k].el; }));
    if (!admin) { Object.keys(f).forEach(function (k) { f[k].input.disabled = true; }); }
    var msg = h('div');
    async function save() {
      var b = { nameAr: f.nameAr.get().trim(), nameEn: f.nameEn.get().trim() || null, address: f.address.get().trim() || null, phone: f.phone.get().trim() || null,
        email: f.email.get().trim() || null, timezone: f.timezone.get(), defaultLanguage: f.defaultLanguage.get() };
      if (b.nameAr.length < 2) { A.toast(t('f.required'), 'error'); f.nameAr.input.focus(); return; }
      await api.put('/api/admin/clinic', b, { csrf: true }); A.toast(t('f.saved'), 'ok');
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    body.appendChild(A.card(null, h('div', null, form, msg, admin ? A.btn(t('f.save'), { onClick: save }) : h('p', { class: 'qm-hint' }, t('f.readonly')))));
  } };

  /* ---------- مساعد CRUD مشترك ---------- */
  async function listPage(root, title, path, columnsFn, openForm, opts) {
    opts = opts || {};
    var admin = A.isAdmin();
    var holder = h('div'); var rows = [];
    root.appendChild(A.pageHead(title, admin && openForm ? [A.btn(t('f.add'), { icon: null, onClick: function () { return openForm(null, reload); } })] : null));
    root.appendChild(h('div', { class: 'qm-card adm-section' }, holder));
    if (!admin && openForm) root.appendChild(h('p', { class: 'qm-hint' }, t('f.readonly')));
    async function reload() {
      A.clear(holder); holder.appendChild(A.loading());
      try { rows = await api.get(path); } catch (e) { A.clear(holder); holder.appendChild(A.errorBox(e, reload)); return; }
      if (opts.sort) rows = opts.sort(rows);
      A.clear(holder); holder.appendChild(A.table(columnsFn(rows, reload, admin), rows));
    }
    await reload();
    return reload;
  }
  var actionsCell = function (list) { return h('div', { class: 'adm-rowactions' }, list); };

  /* ---------- الخدمات ---------- */
  A.views.services = { role: 'manager', render: function (root) {
    function openForm(row, done) {
      var f = { nameAr: A.f.text(t('f.name_ar'), { value: row && row.nameAr, required: true, max: 100 }), nameEn: A.f.text(t('f.name_en'), { value: row && row.nameEn, max: 100, dir: 'ltr' }),
        prefix: A.f.text(t('sv.prefix'), { value: row && row.prefix, required: true, max: 3, dir: 'ltr' }), displayOrder: A.f.number(t('sv.order'), { value: row ? row.displayOrder : 0, min: 0 }),
        est: A.f.number(t('sv.est'), { value: row ? row.estDurationMin : 10, min: 1 }), isActive: A.f.check(t('f.active'), { value: row ? row.isActive : true }) };
      var body = h('form', { class: 'adm-form', novalidate: true, onsubmit: function (e) { e.preventDefault(); } }, Object.keys(f).map(function (k) { return f[k].el; }));
      A.dialog(row ? t('f.edit') : t('f.add'), body, [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('f.save'), onClick: async function (ctx) {
        var b = { nameAr: f.nameAr.get().trim(), nameEn: f.nameEn.get().trim() || null, prefix: f.prefix.get().trim().toUpperCase(), displayOrder: f.displayOrder.get() || 0, estDurationMin: f.est.get() || 10, isActive: f.isActive.get() };
        if (!b.nameAr || !b.prefix) { ctx.error(t('f.required')); return false; }
        if (row) await api.put('/api/admin/services/' + row.id, b, { csrf: true }); else await api.post('/api/admin/services', b, { csrf: true });
        A.toast(t('f.saved'), 'ok'); done(); return true; } }]);
    }
    return listPage(root, t('sv.title'), '/api/admin/services', function (rows, reload, admin) { return [
      { label: t('sv.prefix'), render: function (r) { return h('strong', { class: 'qm-num' }, r.prefix); } }, { label: t('f.name_ar'), key: 'nameAr' }, { label: t('f.name_en'), key: 'nameEn' },
      { label: t('sv.order'), key: 'displayOrder', class: 'qm-num' }, { label: t('sv.est'), key: 'estDurationMin', class: 'qm-num' }, { label: t('f.active'), render: function (r) { return A.activeBadge(r.isActive); } },
      admin ? { label: t('f.actions'), render: function (r) { return actionsCell([
        A.btn(t('f.edit'), { sm: true, kind: 'secondary', onClick: function () { openForm(r, reload); } }),
        A.btn(t('f.delete'), { sm: true, kind: 'danger', onClick: async function () { if (!(await A.confirm(t('f.confirmDelete'), { danger: true }))) return;
          var res = await api.del('/api/admin/services/' + r.id, { csrf: true }); A.toast(res && res.deactivated ? t('sv.deactivated') : t('f.deleted'), 'ok'); reload(); } })]); } } : null
    ].filter(Boolean); }, openForm);
  } };

  /* ---------- الشبابيك ---------- */
  A.views.counters = { role: 'manager', render: async function (root) {
    var services = await api.get('/api/admin/services').catch(function () { return []; });
    var svcName = function (id) { var s = services.filter(function (x) { return x.id === id; })[0]; return s ? s.prefix : id; };
    function openForm(row, done) {
      var f = { nameAr: A.f.text(t('f.name_ar'), { value: row && row.nameAr, required: true, max: 100 }), nameEn: A.f.text(t('f.name_en'), { value: row && row.nameEn, max: 100, dir: 'ltr' }),
        number: A.f.number(t('ct.number'), { value: row && row.number, min: 1, required: true }), isActive: A.f.check(t('f.active'), { value: row ? row.isActive : true }),
        serviceIds: A.f.checks(t('ct.services'), services.map(function (s) { return { value: s.id, label: s.prefix + ' · ' + A.name(s) }; }), row ? row.serviceIds : []) };
      var body = h('form', { class: 'adm-form', novalidate: true, onsubmit: function (e) { e.preventDefault(); } }, Object.keys(f).map(function (k) { return f[k].el; }));
      A.dialog(row ? t('f.edit') : t('f.add'), body, [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('f.save'), onClick: async function (ctx) {
        var b = { nameAr: f.nameAr.get().trim(), nameEn: f.nameEn.get().trim() || null, number: f.number.get(), isActive: f.isActive.get(), serviceIds: f.serviceIds.get() };
        if (!b.nameAr || !b.number) { ctx.error(t('f.required')); return false; }
        if (row) await api.put('/api/admin/counters/' + row.id, b, { csrf: true }); else await api.post('/api/admin/counters', b, { csrf: true });
        A.toast(t('f.saved'), 'ok'); done(); return true; } }]);
    }
    return listPage(root, t('ct.title'), '/api/admin/counters', function (rows, reload, admin) { return [
      { label: t('ct.number'), render: function (r) { return h('strong', { class: 'qm-num' }, r.number); } }, { label: t('f.name_ar'), key: 'nameAr' }, { label: t('f.name_en'), key: 'nameEn' },
      { label: t('ct.services'), render: function (r) { return r.serviceIds.length ? r.serviceIds.map(svcName).join('، ') : '—'; } }, { label: t('f.active'), render: function (r) { return A.activeBadge(r.isActive); } },
      admin ? { label: t('f.actions'), render: function (r) { return actionsCell([
        A.btn(t('f.edit'), { sm: true, kind: 'secondary', onClick: function () { openForm(r, reload); } }),
        A.btn(t('f.delete'), { sm: true, kind: 'danger', onClick: async function () { if (!(await A.confirm(t('f.confirmDelete'), { danger: true }))) return; await api.del('/api/admin/counters/' + r.id, { csrf: true }); A.toast(t('f.deleted'), 'ok'); reload(); } })]); } } : null
    ].filter(Boolean); }, openForm);
  } };

  /* ---------- الموظفون (admin) ---------- */
  function showSecret(title, label, secret) {
    var inp = h('input', { class: 'qm-input qm-num', readonly: true, value: secret, dir: 'ltr', 'aria-label': label });
    A.dialog(title, h('div', { class: 'adm-form' }, h('p', null, label), inp, A.btn(t('f.copy'), { kind: 'secondary', sm: true, onClick: async function () { await QM.copyText(secret); A.toast(t('f.copied'), 'ok'); } })), [{ label: t('f.close'), onClick: function () { return true; } }], { lock: true });
    setTimeout(function () { inp.select(); }, 0);
  }
  A.showSecret = showSecret;

  A.views.staff = { role: 'admin', render: async function (root) {
    var services = await api.get('/api/admin/services').catch(function () { return []; });
    var counters = await api.get('/api/admin/counters').catch(function () { return []; });
    function openForm(row, done) {
      var f = { username: A.f.text(t('a.username'), { value: row && row.username, required: true, max: 32, dir: 'ltr', autocomplete: 'off' }), fullName: A.f.text(t('st.fullName'), { value: row && row.fullName, required: true, max: 100 }),
        role: A.f.select(t('st.role'), ['staff', 'manager', 'admin'].map(function (r) { return { value: r, label: roleLabel(r) }; }), { value: row ? row.role : 'staff' }),
        counter: A.f.select(t('st.counter'), [{ value: '', label: t('f.none') }].concat(counters.map(function (c) { return { value: c.id, label: c.number + ' · ' + A.name(c) }; })), { value: row && row.defaultCounterId || '' }),
        canSkipReturn: A.f.check(t('st.skipReturn'), { value: row && row.canSkipReturn }), canCancel: A.f.check(t('st.cancel'), { value: row && row.canCancel }), canTransfer: A.f.check(t('st.transfer'), { value: row && row.canTransfer }),
        serviceIds: A.f.checks(t('st.services'), services.map(function (s) { return { value: s.id, label: s.prefix + ' · ' + A.name(s) }; }), row ? row.serviceIds : []),
        isActive: A.f.check(t('f.active'), { value: row ? row.isActive : true }) };
      if (!row) f.password = A.f.text(t('st.pwOptional'), { type: 'password', autocomplete: 'new-password', max: 128 });
      var body = h('form', { class: 'adm-form', novalidate: true, onsubmit: function (e) { e.preventDefault(); } }, [f.username.el, f.fullName.el, f.role.el, f.counter.el, h('div', { class: 'qm-label' }, t('st.perms')), f.canSkipReturn.el, f.canCancel.el, f.canTransfer.el, f.serviceIds.el, f.isActive.el, f.password ? f.password.el : null]);
      A.dialog(row ? t('f.edit') : t('f.add'), body, [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('f.save'), onClick: async function (ctx) {
        var b = { username: f.username.get().trim().toLowerCase(), fullName: f.fullName.get().trim(), role: f.role.get(), defaultCounterId: f.counter.get() ? Number(f.counter.get()) : null,
          canSkipReturn: f.canSkipReturn.get(), canCancel: f.canCancel.get(), canTransfer: f.canTransfer.get(), serviceIds: f.serviceIds.get(), isActive: f.isActive.get() };
        if (!b.username || !b.fullName) { ctx.error(t('f.required')); return false; }
        var res;
        if (row) res = await api.put('/api/admin/staff/' + row.id, b, { csrf: true });
        else { if (f.password.get()) b.password = f.password.get(); res = await api.post('/api/admin/staff', b, { csrf: true }); }
        A.toast(t('f.saved'), 'ok'); done();
        if (res && res.temporaryPassword) { ctx.close(); showSecret(b.fullName, t('st.tempPw'), res.temporaryPassword); return false; }
        return true; } }]);
    }
    return listPage(root, t('st.title'), '/api/admin/staff', function (rows, reload) { return [
      { label: t('st.fullName'), render: function (r) { return h('strong', null, r.fullName); } }, { label: t('a.username'), render: function (r) { return h('span', { class: 'qm-latin' }, r.username); } },
      { label: t('st.role'), render: function (r) { return roleLabel(r.role); } }, { label: t('st.lastLogin'), render: function (r) { return A.dt(r.lastLoginAt); } },
      { label: t('f.active'), render: function (r) { return A.activeBadge(r.isActive); } },
      { label: t('f.actions'), render: function (r) { return actionsCell([
        A.btn(t('f.edit'), { sm: true, kind: 'secondary', onClick: function () { openForm(r, reload); } }),
        A.btn(t('st.resetPw'), { sm: true, kind: 'secondary', onClick: async function () { if (!(await A.confirm(t('st.confirmReset')))) return;
          var res = await api.post('/api/admin/staff/' + r.id + '/reset-password', {}, { csrf: true }); showSecret(r.fullName, t('st.tempPw'), res.temporaryPassword); reload(); } }),
        r.isActive ? A.btn(t('st.deactivate'), { sm: true, kind: 'danger', onClick: async function () { if (!(await A.confirm(t('st.confirmDeactivate'), { danger: true }))) return; await api.del('/api/admin/staff/' + r.id, { csrf: true }); A.toast(t('f.saved'), 'ok'); reload(); } }) : null]); } }
    ]; }, openForm);
  } };

  /* ---------- سجل التدقيق (admin) ---------- */
  A.views.audit = { role: 'admin', render: async function (root) {
    var page = 1; var filter = '';
    var out = h('div'); var fi = h('input', { class: 'qm-input adm-search', type: 'search', placeholder: t('au.filter'), 'aria-label': t('au.filter'), dir: 'ltr' });
    var tm; fi.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () { filter = fi.value.trim(); page = 1; load(); }, 300); });
    root.appendChild(A.pageHead(t('au.title'), [fi])); root.appendChild(h('div', { class: 'qm-card adm-section' }, out));
    async function load() {
      A.clear(out); out.appendChild(A.loading());
      try {
        var d = await api.get('/api/admin/audit', { query: { page: page, pageSize: 50, action: filter || undefined } });
        A.clear(out);
        out.appendChild(A.table([{ label: t('au.when'), render: function (r) { return A.dt(r.createdAt); } }, { label: t('au.action'), render: function (r) { return h('code', { class: 'qm-latin' }, r.action); } },
          { label: t('au.entity'), render: function (r) { return r.entity ? r.entity + (r.entityId ? ' #' + r.entityId : '') : '—'; } }, { label: t('au.who'), render: function (r) { return r.username || '—'; } }, { label: t('au.ip'), render: function (r) { return h('span', { class: 'qm-latin' }, r.ip || '—'); } }], d.items));
        out.appendChild(A.pager(d.page, Math.max(1, Math.ceil(d.total / d.pageSize)), function (p) { page = p; load(); }));
      } catch (e) { A.clear(out); out.appendChild(A.errorBox(e, load)); }
    }
    load();
  } };

  A.pager = function (page, pages, go) {
    return h('div', { class: 'adm-pager' }, A.btn(t('f.prev'), { sm: true, kind: 'secondary', onClick: function () { if (page > 1) go(page - 1); } }),
      h('span', null, t('f.page', { p: A.num(page), n: A.num(pages) })), A.btn(t('f.next'), { sm: true, kind: 'secondary', onClick: function () { if (page < pages) go(page + 1); } }));
  };
})();
