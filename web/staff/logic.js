/* Staff console pure logic (no DOM): ticket normalisation, permission-aware actions, scan parsing, error mapping. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.staffLogic = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  var ACTIONS = ['call-next', 'recall', 'start', 'complete', 'skip', 'return', 'cancel', 'transfer'];

  /* The contract does not spell out the ticket object of /queue/* answers, so accept the obvious variants. */
  function normalizeTicket(raw) {
    if (!raw) return null; var r = raw.ticket && !raw.number && !raw.display_number ? raw.ticket : raw;
    var svc = r.service != null ? r.service : (r.serviceName != null ? r.serviceName : null);
    var svcObj = svc && typeof svc === 'object' ? svc : (svc ? { name: String(svc) } : null);
    var c = r.counter != null ? r.counter : null;
    var counter = c == null ? null : (typeof c === 'object' ? c : { number: c });
    return { publicId: r.publicId || r.public_id || r.id || null, number: r.number || r.display_number || r.displayNumber || '', status: r.status || 'waiting',
      service: svcObj, serviceKey: svcObj && svcObj.key || null, servicePrefix: svcObj && svcObj.prefix || null, serviceId: r.serviceId != null ? r.serviceId : (svcObj && svcObj.id != null ? svcObj.id : null), counter: counter,
      issuedAt: r.issuedAt || r.issued_at || null, calledAt: r.calledAt || r.called_at || null, servingAt: r.servingAt || r.serving_at || null,
      waitedMin: r.waitedMin != null ? r.waitedMin : null, isToday: r.isToday, authorizedForService: r.authorizedForService };
  }

  /* permissions come as {can_cancel..} / {cancel..} / ['can_cancel'] / top-level flags; role alone grants nothing */
  function perms(staff) {
    var p = (staff && staff.permissions) || {}, out = { skipReturn: false, cancel: false, transfer: false };
    function has(names) {
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (Array.isArray(p) ? p.indexOf(n) >= 0 : !!p[n]) return true;
        if (staff && !Array.isArray(p) && !!staff[n]) return true;
        if (staff && Array.isArray(p) && !!staff[n]) return true;
      } return false;
    }
    out.skipReturn = has(['can_skip_return', 'canSkipReturn', 'skip_return', 'skipReturn']);
    out.cancel = has(['can_cancel', 'canCancel', 'cancel']);
    out.transfer = has(['can_transfer', 'canTransfer', 'transfer']);
    return out;
  }
  function sameCounter(a, b) {
    if (!a || !b) return true;                       // unknown -> let the server decide
    if (a.id != null && b.id != null) return a.id === b.id;
    if (a.number != null && b.number != null) return String(a.number) === String(b.number);
    return true;
  }
  /* Which buttons to show for a ticket. Server still validates; this only hides what can never apply. */
  function availableActions(ticket, staff, myCounter) {
    if (!ticket) return [];
    var p = perms(staff), mine = sameCounter(ticket.counter, myCounter), out = [];
    switch (ticket.status) {
      case 'waiting': if (p.cancel) out.push('cancel'); if (p.transfer) out.push('transfer'); break;
      case 'called': if (mine) out.push('start', 'recall', 'skip'); if (p.cancel) out.push('cancel'); if (p.transfer) out.push('transfer'); break;
      case 'serving': if (mine) out.push('complete'); if (p.cancel) out.push('cancel'); break;
      case 'skipped': if (p.skipReturn) out.push('return'); break;
    }
    return out;
  }

  function normalizeTicketNumber(s) {
    var m = /^\s*([A-Za-z]{1,3})\s*[-_ ]?\s*(\d{1,5})\s*$/.exec(String(s || '')); if (!m) return null;
    var n = m[2].replace(/^0+(?=\d)/, ''); while (n.length < 3) n = '0' + n; return m[1].toUpperCase() + '-' + n;
  }
  /* what a QR scan / pasted text / USB scanner can contain: the ticket link, a bare token, or a ticket number */
  function parseScan(text) {
    var s = String(text || '').trim(); if (!s) return null;
    var m = /[?&]t=([A-Za-z0-9_-]{8,128})(?:[&#]|$)/.exec(s); if (m) return { token: m[1] };
    var num = normalizeTicketNumber(s); if (num) return { number: num };
    if (/^[A-Za-z0-9_-]{16,128}$/.test(s)) return { token: s };
    return null;
  }

  /* error -> how the UI should react */
  function classifyError(err) {
    var c = err && err.code;
    if (c === 'QUEUE_EMPTY') return { level: 'info', refresh: false, code: c };
    if (c === 'UNAUTHENTICATED') return { level: 'session', refresh: false, code: c };
    if (c === 'ALREADY_CALLED' || c === 'INVALID_TRANSITION' || c === 'NOT_FOUND' || c === 'FORBIDDEN_SERVICE' || c === 'CONFLICT') return { level: 'error', refresh: true, code: c };
    return { level: 'error', refresh: false, code: c };
  }

  function elapsed(fromIso, nowMs) {
    if (!fromIso) return ''; var s = Math.max(0, Math.floor(((nowMs || Date.now()) - Date.parse(fromIso)) / 1000)); if (isNaN(s)) return '';
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60, pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' : '') + pad(m) + ':' + pad(sec);
  }
  /* counters list from login/me data; falls back to the single `counter` of the contract */
  function counterOptions(staff) {
    var list = staff && Array.isArray(staff.counters) && staff.counters.length ? staff.counters : (staff && staff.counter ? [staff.counter] : []);
    return list.filter(Boolean);
  }
  function pickCounter(staff, savedId) {
    var opts = counterOptions(staff); if (!opts.length) return null;
    var saved = opts.filter(function (c) { return c.id === savedId; })[0]; if (saved) return saved;
    var def = staff.counter && opts.filter(function (c) { return c.id === staff.counter.id; })[0];
    return opts.length === 1 ? opts[0] : (def || null);
  }
  return { normalizeTicket: normalizeTicket, perms: perms, availableActions: availableActions, normalizeTicketNumber: normalizeTicketNumber, parseScan: parseScan,
    classifyError: classifyError, elapsed: elapsed, counterOptions: counterOptions, pickCounter: pickCounter, sameCounter: sameCounter, ACTIONS: ACTIONS };
});
