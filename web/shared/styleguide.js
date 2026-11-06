(function () {
  try { if (!localStorage.getItem('qm.lang')) QM.i18n.setLang('en', false); } catch (e) { QM.i18n.setLang('en', false); }   // the guide text is English; switch to AR to check mirroring
  var $ = function (s, r) { return (r || document).querySelector(s); };
  // inline icons for every [data-icon]
  function hydrate(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-icon]'), function (el) {
      if (el.getAttribute('data-done')) return; el.setAttribute('data-done', '1');
      var svg = QM.icon(el.getAttribute('data-icon'), { size: Number(el.getAttribute('data-size')) || 20 });
      if (el.tagName === 'SPAN' && !el.children.length && !el.textContent.trim() || el.classList.contains('qm-list__check') || el.classList.contains('qm-pulse')) el.innerHTML = svg;
      else el.insertAdjacentHTML('afterbegin', svg + ' ');
    });
  }
  var colors = [['--brand', 'brand (injected)'], ['--brand-action', 'brand action'], ['--brand-action-hover', 'action hover'], ['--brand-soft', 'brand soft'],
    ['--qm-navy-900', 'navy 900'], ['--qm-navy-800', 'navy 800'], ['--qm-navy-700', 'navy 700'], ['--qm-navy-500', 'navy 500'],
    ['--qm-gray-25', 'gray 25 (page)'], ['--qm-gray-50', 'gray 50'], ['--qm-gray-100', 'gray 100'], ['--qm-gray-200', 'gray 200 (hairline)'], ['--qm-gray-300', 'gray 300'], ['--qm-gray-500', 'gray 500 (muted text)'], ['--qm-gray-900', 'gray 900 (text)'],
    ['--qm-st-waiting', 'status waiting'], ['--qm-st-called', 'status called'], ['--qm-st-serving', 'status serving'], ['--qm-st-completed', 'status completed'], ['--qm-st-skipped', 'status skipped'], ['--qm-st-cancelled', 'status cancelled'], ['--qm-danger', 'danger']];
  function paintColors() {
    var cs = getComputedStyle(document.documentElement);
    $('#sg-colors').innerHTML = colors.map(function (c) {
      var v = cs.getPropertyValue(c[0]).trim(), ratio = QM.brand.contrast(v, '#FFFFFF');
      return '<div class="sg-swatch"><i style="background:var(' + c[0] + ')"></i><strong>' + c[1] + '</strong><code>' + c[0] + '</code><span>' + v + ' &middot; ' + ratio.toFixed(1) + ':1 with white</span></div>';
    }).join('');
    var d = QM.brand.derive($('#sg-brand').value); $('#sg-contrast').textContent = 'action ' + d.action + ' = ' + QM.brand.contrast(d.action, '#FFFFFF').toFixed(1) + ':1';
  }
  $('#sg-type').innerHTML = [['xs/sm 14/20', 'caption, meta', 14, 20], ['md 16/24', 'body, fields', 16, 24], ['lg 20/28', 'section title', 20, 28], ['xl 24/32', 'screen title', 24, 32], ['2xl 32/40', 'page title', 32, 40], ['3xl 48/56', 'display', 48, 56]]
    .map(function (r) { return '<div><code>' + r[0] + '</code><span style="font-size:' + r[2] + 'px;line-height:' + r[3] + 'px">' + r[1] + ' / ' + (document.documentElement.lang === 'ar' ? 'نص تجريبي' : 'Sample text') + '</span></div>'; }).join('');
  $('#sg-space').innerHTML = [4, 8, 12, 16, 24, 32, 48, 64].map(function (n) { return '<div><i style="inline-size:' + n + 'px;block-size:' + n + 'px"></i><span>' + n + '</span></div>'; }).join('');
  var st = ['waiting', 'approaching', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'offline'];
  $('#sg-status').innerHTML = st.map(function (s) { return '<span class="qm-status" data-status="' + s + '">' + (s[0].toUpperCase() + s.slice(1)) + '</span>'; }).join('') +
    '<span class="qm-status qm-status--icon" data-status="called">' + QM.icon('bell-ring', { size: 20 }) + 'With icon</span><span class="qm-status qm-status--icon" data-status="serving">' + QM.icon('circle-check', { size: 20 }) + 'With icon</span>';
  $('#sg-icons').innerHTML = Object.keys(QM.icons).map(function (n) { return '<div>' + QM.icon(n, { size: 24 }) + '<span>' + n + '</span></div>'; }).join('');
  hydrate();
  paintColors();
  $('#sg-brand').addEventListener('input', function (e) { QM.brand.apply(e.target.value); paintColors(); });
  QM.bindLangSwitch && QM.bindLangSwitch(QM.i18n);
  document.addEventListener('click', function (e) { var b = e.target.closest('.qm-lang button[data-lang]'); if (b) QM.i18n.setLang(b.getAttribute('data-lang')); });
  document.addEventListener('click', function (e) { var t = e.target.closest('[data-toast]'); if (t) QM.toast(t.getAttribute('data-toast') === 'error' ? 'Cannot reach the server' : 'Ticket saved', t.getAttribute('data-toast') === 'info' ? undefined : t.getAttribute('data-toast')); });
  $('#sg-modal').addEventListener('click', function () { QM.modal({ title: 'Cancel ticket A-025', bodyHtml: '<p>The ticket will be cancelled permanently.</p>', actions: [{ label: 'Back', kind: 'secondary', value: false }, { label: 'Cancel ticket', kind: 'danger', value: true }] }); });
  $('#sg-list').addEventListener('click', function (e) { var b = e.target.closest('button[role=radio]'); if (!b) return; Array.prototype.forEach.call(this.querySelectorAll('button[role=radio]'), function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); }); });
  var n = 3; $('#sg-replay').addEventListener('click', function () {
    var m = $('#sg-motion'); Array.prototype.forEach.call(m.querySelectorAll('.qm-check-draw circle, .qm-check-draw path'), function (el) { el.style.animation = 'none'; void el.getBoundingClientRect(); el.style.animation = ''; });
    QM.motion.setRolling($('#sg-roll'), ++n); QM.motion.replay($('#sg-list'), 'qm-stagger'); Array.prototype.forEach.call(document.querySelectorAll('.qm-stagger'), function (l) { l.classList.remove('qm-stagger'); void l.offsetWidth; l.classList.add('qm-stagger'); });
  });
  QM.i18n.onChange(function () { /* direction flips via <html dir>; nothing else to redraw */ });
})();
