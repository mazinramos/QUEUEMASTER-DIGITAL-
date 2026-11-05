/* الشاشات والصوت (ح4: /api/admin/displays) + المزامنة والرسائل (حسابي: /api/admin/stats/integrations). */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var api = A.api;
  A.views = A.views || {};

  function settingsForm(s) {
    var f = {
      announce_lang: A.f.select(t('dp.lang'), [{ value: 'both', label: t('dp.both') }, { value: 'ar', label: t('dp.ar') }, { value: 'en', label: t('dp.en') }], { value: s.announce_lang }),
      audio_enabled: A.f.check(t('dp.audio'), { value: s.audio_enabled }),
      volume: A.f.number(t('dp.volume') + ' (0–1)', { value: s.volume, min: 0, step: 0.1 }), speech_rate: A.f.number(t('dp.rate'), { value: s.speech_rate, min: 0.5, step: 0.1 }),
      speech_pitch: A.f.number(t('dp.pitch'), { value: s.speech_pitch, min: 0.5, step: 0.1 }), repeat_count: A.f.number(t('dp.repeat'), { value: s.repeat_count, min: 1, step: 1 }),
      repeat_delay_ms: A.f.number(t('dp.delay'), { value: s.repeat_delay_ms, min: 0, step: 100 })
    };
    return { f: f, els: Object.keys(f).map(function (k) { return f[k].el; }), get: function () { var o = {}; Object.keys(f).forEach(function (k) { var v = f[k].get(); if (v !== null && v !== '') o[k] = v; }); return o; } };
  }

  A.views.displays = { role: 'admin', render: async function (root) {
    var holder = h('div');
    root.appendChild(A.pageHead(t('dp.title'), [A.btn(t('f.add'), { onClick: create })]));
    root.appendChild(h('div', { class: 'qm-card adm-section' }, holder));
    async function reload() {
      A.clear(holder); holder.appendChild(A.loading());
      try {
        var d = await api.get('/api/admin/displays'); A.clear(holder);
        holder.appendChild(A.table([
          { label: t('dp.name'), render: function (x) { return h('strong', null, x.name); } },
          { label: t('q.status'), render: function (x) { return A.activeBadge(x.isActive !== false && x.is_active !== 0); } },
          { label: t('dp.lang'), render: function (x) { var s = x.settings || {}; return s.announce_lang ? t('dp.' + s.announce_lang) : '—'; } },
          { label: t('dp.audio'), render: function (x) { return x.settings && x.settings.audio_enabled ? t('f.yes') : t('f.no'); } },
          { label: t('f.actions'), render: function (x) { return h('div', { class: 'adm-rowactions' },
            A.btn(t('dp.settings'), { sm: true, kind: 'secondary', onClick: function () { editSettings(x); } }),
            A.btn(t('dp.resetPairing'), { sm: true, kind: 'secondary', icon: 'key-round', onClick: async function () { if (!(await A.confirm(t('dp.confirmReset')))) return; var r = await api.post('/api/admin/displays/' + x.id + '/reset-pairing', {}, { csrf: true }); A.showSecret(x.name, t('dp.pairing'), r.pairingCode); } }),
            A.btn(t('f.delete'), { sm: true, kind: 'danger', onClick: async function () { if (!(await A.confirm(t('dp.confirmDelete'), { danger: true }))) return; await api.del('/api/admin/displays/' + x.id, { csrf: true }); A.toast(t('f.deleted'), 'ok'); reload(); } })); } }
        ], d.displays));
      } catch (e) { A.clear(holder); holder.appendChild(A.errorBox(e, reload)); }
    }
    function create() {
      var name = A.f.text(t('dp.name'), { required: true, max: 80 });
      A.dialog(t('dp.new'), h('form', { class: 'adm-form', onsubmit: function (e) { e.preventDefault(); } }, name.el), [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('f.save'), onClick: async function (ctx) {
        if (!name.get().trim()) { ctx.error(t('f.required')); return false; }
        var r = await api.post('/api/admin/displays', { name: name.get().trim() }, { csrf: true }); reload(); ctx.close(); A.showSecret(name.get().trim(), t('dp.pairing'), r.pairingCode); return false; } }]);
    }
    function editSettings(x) {
      var nm = A.f.text(t('dp.name'), { value: x.name, required: true, max: 80 }); var sf = settingsForm(x.settings || {});
      A.dialog(x.name, h('form', { class: 'adm-form', onsubmit: function (e) { e.preventDefault(); } }, [nm.el].concat(sf.els)), [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('f.save'), onClick: async function (ctx) {
        if (!nm.get().trim()) { ctx.error(t('f.required')); return false; }
        if (nm.get().trim() !== x.name) await api.put('/api/admin/displays/' + x.id, { name: nm.get().trim() }, { csrf: true });
        await api.put('/api/admin/displays/' + x.id + '/settings', sf.get(), { csrf: true }); A.toast(t('f.saved'), 'ok'); reload(); return true; } }], { wide: true });
    }
    reload();
  } };

  function kv(label, value) { return h('div', { class: 'adm-kv' }, h('div', { class: 'adm-kv__k' }, label), h('div', { class: 'adm-kv__v' }, value)); }
  A.views.integrations = { role: 'manager', render: async function (root) {
    root.appendChild(A.pageHead(t('in.title'), [A.btn(t('d.refresh'), { kind: 'secondary', sm: true, icon: 'refresh-cw', onClick: load })]));
    root.appendChild(h('div', { class: 'qm-banner qm-banner--info' }, h('div', { class: 'qm-banner__body' }, t('in.note'))));
    var out = h('div', { class: 'adm-grid2' }); root.appendChild(out);
    var yesno = function (b, y, n) { return A.badge(b ? y : n, b ? 'serving' : 'cancelled'); };
    var err = function (e) { return e ? h('span', null, e.message, ' ', h('span', { class: 'qm-hint' }, A.dt(e.at))) : t('in.none'); };
    async function load() {
      A.clear(out); out.appendChild(A.loading());
      try {
        var d = await api.get('/api/admin/stats/integrations'); A.clear(out);
        out.appendChild(A.card(t('in.sms'), h('div', null,
          kv(t('in.enabled'), yesno(d.sms.enabled, t('in.on'), t('in.off'))), kv(t('in.provider'), d.sms.provider), kv(t('in.credentials'), yesno(d.sms.providerConfigured, t('in.configured'), t('in.notConfigured'))),
          kv(t('in.encKey'), yesno(d.sms.encryptionKeyConfigured, t('in.configured'), t('in.notConfigured'))),
          kv(t('in.pending'), A.num(d.sms.counts.pending)), kv(t('in.sent'), A.num(d.sms.counts.sent)), kv(t('in.failed'), A.num(d.sms.counts.failed)), kv(t('in.expired'), A.num(d.sms.counts.expired)),
          kv(t('in.oldest'), d.sms.oldestPendingAt ? A.dt(d.sms.oldestPendingAt) : t('in.none')), kv(t('in.lastErr'), err(d.sms.lastError)))));
        out.appendChild(A.card(t('in.sync'), h('div', null,
          kv(t('in.credentials'), yesno(d.sync.credentialsDetected, t('in.configured'), t('in.notConfigured'))),
          kv(t('in.pending'), A.num(d.sync.counts.pending)), kv(t('in.synced'), A.num(d.sync.counts.synced)), kv(t('in.failed'), A.num(d.sync.counts.failed)),
          kv(t('in.oldest'), d.sync.oldestPendingAt ? A.dt(d.sync.oldestPendingAt) : t('in.none')), kv(t('in.lastSync'), d.sync.lastSyncedAt ? A.dt(d.sync.lastSyncedAt) : t('in.none')), kv(t('in.lastErr'), err(d.sync.lastError)))));
      } catch (e) { A.clear(out); out.appendChild(A.errorBox(e, load)); }
    }
    load();
  } };
})();
