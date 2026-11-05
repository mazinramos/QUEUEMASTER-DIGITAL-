/* الإعلانات (حسابي): رفع صورة/فيديو/نص، جدولة، أولوية، استهداف شاشات، معاينة. الباك إند: /api/admin/ads */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var api = A.api;
  A.views = A.views || {};
  var STATUS_KIND = { active: 'serving', scheduled: 'waiting', expired: 'completed', inactive: 'cancelled' };

  function mediaNode(ad) {
    if (ad.mediaType === 'image' && ad.url) return h('img', { class: 'adm-media', src: ad.url, alt: ad.title, loading: 'lazy' });
    if (ad.mediaType === 'video' && ad.url) return h('video', { class: 'adm-media', src: ad.url, controls: true, muted: true, preload: 'metadata', 'aria-label': ad.title });
    return h('div', { class: 'adm-media adm-media--text' }, ad.bodyText || '');
  }

  A.views.ads = { role: 'manager', render: async function (root) {
    var admin = true; // الإعلانات تُدار من manager فأعلى (حسب الباك إند)
    var displays = []; try { displays = (await api.get('/api/admin/displays')).displays || []; } catch (e) { displays = []; }
    var holder = h('div');
    root.appendChild(A.pageHead(t('ad.title'), [A.btn(t('f.add'), { onClick: function () { openForm(null); } })]));
    root.appendChild(h('p', { class: 'qm-hint' }, t('ad.limits', { i: 5, v: 50 })));
    root.appendChild(h('div', { class: 'qm-card adm-section' }, holder));

    async function reload() {
      A.clear(holder); holder.appendChild(A.loading());
      try {
        var d = await api.get('/api/admin/ads'); A.clear(holder);
        holder.appendChild(A.table([
          { label: '', render: function (a) { return a.url && a.mediaType === 'image' ? h('img', { class: 'adm-thumb', src: a.url, alt: '' }) : h('span', { class: 'adm-thumb adm-thumb--ph' }, t('ad.' + a.mediaType)); } },
          { label: t('ad.adTitle'), render: function (a) { return h('strong', null, a.title); } }, { label: t('ad.type'), render: function (a) { return t('ad.' + a.mediaType); } },
          { label: t('q.status'), render: function (a) { return A.badge(t('ad.status.' + a.status), STATUS_KIND[a.status]); } },
          { label: t('ad.priority'), key: 'priority', class: 'qm-num' }, { label: t('ad.duration'), key: 'durationSec', class: 'qm-num' },
          { label: t('ad.window'), render: function (a) { return a.startsAt || a.endsAt ? [a.startsAt ? A.dt(a.startsAt) : '…', ' → ', a.endsAt ? A.dt(a.endsAt) : '…'].join('') : '—'; } },
          { label: t('f.actions'), render: function (a) { return h('div', { class: 'adm-rowactions' },
            A.btn(t('ad.preview'), { sm: true, kind: 'secondary', icon: 'eye', onClick: function () { return preview(a); } }),
            A.btn(t('f.edit'), { sm: true, kind: 'secondary', onClick: function () { openForm(a); } }),
            A.btn(t('f.delete'), { sm: true, kind: 'danger', onClick: async function () { if (!(await A.confirm(t('ad.confirmDelete'), { danger: true }))) return; await api.del('/api/admin/ads/' + a.id, { csrf: true }); A.toast(t('f.deleted'), 'ok'); reload(); } })); } }
        ], d.ads));
      } catch (e) { A.clear(holder); holder.appendChild(A.errorBox(e, reload)); }
    }

    async function preview(a) {
      var p = await api.get('/api/admin/ads/' + a.id + '/preview');
      A.dialog(t('ad.preview') + ' — ' + p.ad.title, h('div', { class: 'adm-form' }, mediaNode(p.ad), h('div', null, A.badge(t('ad.status.' + p.ad.status), STATUS_KIND[p.ad.status])), h('p', { class: 'qm-hint' }, p.note)), [{ label: t('f.close'), onClick: function () { return true; } }]);
    }

    function openForm(ad) {
      var f = {
        title: A.f.text(t('ad.adTitle'), { value: ad && ad.title, required: true, max: 120 }),
        type: A.f.select(t('ad.type'), ['image', 'video', 'text'].map(function (m) { return { value: m, label: t('ad.' + m) }; }), { value: ad ? ad.mediaType : 'image' }),
        body: A.f.area(t('ad.body'), { value: ad && ad.bodyText, max: 500 }),
        duration: A.f.number(t('ad.duration'), { value: ad ? ad.durationSec : 15, min: 3, step: 1 }), priority: A.f.number(t('ad.priority'), { value: ad ? ad.priority : 0, step: 1 }),
        starts: A.f.datetime(t('ad.starts'), { value: ad && ad.startsAt }), ends: A.f.datetime(t('ad.ends'), { value: ad && ad.endsAt }),
        active: A.f.check(t('f.active'), { value: ad ? ad.isActive : true }),
        targets: A.f.checks(t('ad.targets'), displays.map(function (d) { return { value: d.id, label: d.name }; }), ad && ad.displayIds ? ad.displayIds : [], { empty: t('ad.noTarget') })
      };
      var fileId = 'f-ad-file';
      var fileIn = h('input', { id: fileId, class: 'qm-input', type: 'file', accept: 'image/jpeg,image/png,image/webp,video/mp4' });
      var fileField = h('div', { class: 'qm-field' }, h('label', { class: 'qm-label', for: fileId }, t('ad.file')), fileIn, ad && ad.url ? h('div', { class: 'qm-hint' }, t('ad.keepFile')) : null);
      var allToggle = A.f.check(t('ad.allDisplays'), { value: !(ad && ad.displayIds) });
      function sync() { var type = f.type.get(); fileField.hidden = type === 'text'; f.body.el.hidden = type !== 'text'; f.targets.el.hidden = allToggle.get(); }
      f.type.input.addEventListener('change', sync); allToggle.input.addEventListener('change', sync);
      var body = h('form', { class: 'adm-form', novalidate: true, onsubmit: function (e) { e.preventDefault(); } }, [f.title.el, f.type.el, fileField, f.body.el, f.duration.el, f.priority.el, f.starts.el, f.ends.el, allToggle.el, f.targets.el, f.active.el]);
      sync();
      A.dialog(ad ? t('f.edit') : t('f.add'), body, [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('f.save'), onClick: async function (ctx) {
        var fd = new FormData(); var type = f.type.get();
        if (!f.title.get().trim()) { ctx.error(t('f.required')); return false; }
        fd.append('title', f.title.get().trim()); fd.append('media_type', type);
        if (type === 'text') fd.append('body_text', f.body.get().trim());
        fd.append('duration_sec', String(f.duration.get() || 15)); fd.append('priority', String(f.priority.get() || 0));
        fd.append('starts_at', f.starts.get() || ''); fd.append('ends_at', f.ends.get() || '');
        fd.append('is_active', f.active.get() ? 'true' : 'false');
        fd.append('display_ids', allToggle.get() ? 'null' : JSON.stringify(f.targets.get()));
        if (type !== 'text' && fileIn.files[0]) fd.append('file', fileIn.files[0]);
        if (ad) await A.upload('PUT', '/api/admin/ads/' + ad.id, fd); else await A.upload('POST', '/api/admin/ads', fd);
        A.toast(t('f.saved'), 'ok'); reload(); return true; } }], { wide: true });
    }
    reload();
  } };
})();
