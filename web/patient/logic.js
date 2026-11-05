/* Patient portal pure logic (no DOM) so it can be unit-tested. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.patientLogic = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  var STORE_KEY = 'qm.patient.ticket', CLINIC_KEY = 'qm.patient.clinic';
  var FINAL = ['completed', 'cancelled'];

  function createStore(storage) {
    function read(k) { try { var v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
    function write(k, v) { try { storage && storage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
    return {
      loadTicket: function () { var t = read(STORE_KEY); return t && typeof t.token === 'string' && t.token ? t : null; },
      saveTicket: function (t) { return write(STORE_KEY, t); },
      clearTicket: function () { try { storage && storage.removeItem(STORE_KEY); } catch (e) {} },
      loadClinic: function () { return read(CLINIC_KEY); },
      saveClinic: function (c) { return write(CLINIC_KEY, c); }
    };
  }

  /* ?t=<token> from the QR link. Only URL-safe token characters are accepted. */
  function parseTokenFromSearch(search) {
    var m = /[?&]t=([^&#]*)/.exec(search || ''); if (!m) return null;
    var v; try { v = decodeURIComponent(m[1]); } catch (e) { return null; }
    return /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : null;
  }
  function ticketUrl(origin, token) { return String(origin).replace(/\/+$/, '') + '/patient/?t=' + encodeURIComponent(token); }

  /* A-025 / a25 / "A 25" -> A-025 ; returns null when not a ticket number */
  function normalizeTicketNumber(s) {
    var m = /^\s*([A-Za-z]{1,3})\s*[-_ ]?\s*(\d{1,5})\s*$/.exec(String(s || '')); if (!m) return null;
    var n = m[2].replace(/^0+(?=\d)/, ''); while (n.length < 3) n = '0' + n; return m[1].toUpperCase() + '-' + n;
  }
  /* optional SMS phone: spaces/dashes/() stripped, optional leading +, 7-15 digits */
  function normalizePhone(s) {
    var v = String(s || '').replace(/[\s\-()]/g, '').replace(/^00/, '+');
    return /^\+?\d{7,15}$/.test(v) ? v : null;
  }
  function isFinal(status) { return FINAL.indexOf(status) >= 0; }
  function isActive(t) { return !!t && !isFinal(t.status); }
  /* alert the patient when they newly become 'called', or when a recall arrives */
  function shouldAlert(prevStatus, nextStatus, event) { return (nextStatus === 'called' && prevStatus !== 'called') || event === 'ticket:recalled'; }

  /* merge a GET /api/public/tickets/:token answer into the stored ticket */
  function mergeServer(saved, d) {
    var out = Object.assign({}, saved);
    if (!d) return out;
    ['number', 'status', 'ahead', 'estimatedWaitMin', 'counter', 'issuedAt'].forEach(function (k) { if (d[k] !== undefined) out[k] = d[k]; });
    if (d.service !== undefined) out.service = d.service; else if (d.serviceName !== undefined) out.service = d.serviceName;
    return out;
  }
  /* patch from a socket payload (status/counter only; ahead/wait come from the next fetch) */
  function mergeEvent(saved, ev, payload) {
    var out = Object.assign({}, saved); if (!payload) return out;
    var st = payload.ticket && payload.ticket.status;
    var map = { 'ticket:called': 'called', 'ticket:recalled': 'called', 'ticket:serving': 'serving', 'ticket:completed': 'completed', 'ticket:skipped': 'skipped', 'ticket:cancelled': 'cancelled' };
    out.status = map[ev] || st || out.status;
    if (payload.counter) out.counter = payload.counter;
    if (out.status !== 'called' && out.status !== 'serving' && out.status !== 'completed') { /* keep counter only while relevant */ if (out.status === 'skipped' || out.status === 'cancelled') out.counter = null; }
    return out;
  }
  function counterNumber(c) { if (c == null) return null; if (typeof c === 'number') return c; if (typeof c === 'string') return c; return c.number != null ? c.number : null; }
  /* signature of what is displayed, so identical polls do not re-render */
  function signature(t, stale) { return JSON.stringify([t && t.status, t && t.ahead, t && t.estimatedWaitMin, counterNumber(t && t.counter), t && t.number, !!stale]); }
  return { createStore: createStore, parseTokenFromSearch: parseTokenFromSearch, ticketUrl: ticketUrl, normalizeTicketNumber: normalizeTicketNumber,
    normalizePhone: normalizePhone, isFinal: isFinal, isActive: isActive, shouldAlert: shouldAlert, mergeServer: mergeServer, mergeEvent: mergeEvent,
    counterNumber: counterNumber, signature: signature, STORE_KEY: STORE_KEY };
});
