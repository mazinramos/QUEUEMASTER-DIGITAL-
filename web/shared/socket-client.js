/* QueueMaster Socket.IO helper + resilient polling.
   - Requires the socket.io client served by the backend at /socket.io/socket.io.js (global `io`).
   - Ignores events whose eventId was already seen (memory of the last 200), as socket-events.md requires.
   - Reports status: 'connecting' | 'online' | 'offline'. If `io` is missing the status is simply 'offline' and polling takes over. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.createDeduper = api.createDeduper; root.QM.createSocketClient = api.createSocketClient; root.QM.createPoller = api.createPoller; }
})(typeof self !== 'undefined' ? self : this, function () {
  var EVENTS = ['ticket:created', 'ticket:called', 'ticket:recalled', 'ticket:serving', 'ticket:completed', 'ticket:skipped',
    'ticket:cancelled', 'queue:updated', 'display:announcement', 'display:settings_updated', 'advertisement:updated'];

  function createDeduper(max) {
    max = max || 200;
    var set = new Set(), order = [];
    return {
      /* true if id was seen before; otherwise remembers it and returns false. Events without id are never deduped. */
      seen: function (id) {
        if (!id) return false;
        if (set.has(id)) return true;
        set.add(id); order.push(id);
        if (order.length > max) set.delete(order.shift());
        return false;
      },
      size: function () { return set.size; }
    };
  }

  function createSocketClient(opts) {
    opts = opts || {};
    var ioFn = opts.io || (typeof io !== 'undefined' ? io : null);
    var status = ioFn ? 'connecting' : 'offline';
    var statusHandlers = [], connectHandlers = [], handlers = {};
    var dedupe = createDeduper(200);
    var watchToken = null, firstConnect = true, sock = null;

    function setStatus(s) { if (s === status) return; status = s; statusHandlers.slice().forEach(function (fn) { try { fn(s); } catch (e) {} }); }

    if (ioFn) {
      sock = ioFn(opts.url || undefined, { path: opts.path || '/socket.io', withCredentials: true, reconnection: true,
        reconnectionDelay: 1000, reconnectionDelayMax: 8000, randomizationFactor: 0.4, timeout: 8000,
        transports: opts.transports || ['websocket', 'polling'] });
      sock.on('connect', function () {
        setStatus('online');
        if (watchToken) sock.emit('ticket:watch', { token: watchToken });
        var wasFirst = firstConnect; firstConnect = false;
        connectHandlers.slice().forEach(function (h) { try { h.fn(wasFirst); } catch (e) {} });
      });
      sock.on('disconnect', function () { setStatus('offline'); });
      sock.on('connect_error', function () { setStatus('offline'); });
      EVENTS.forEach(function (ev) {
        sock.on(ev, function (payload) {
          if (payload && dedupe.seen(payload.eventId)) return;
          (handlers[ev] || []).slice().forEach(function (fn) { try { fn(payload, ev); } catch (e) { if (typeof console !== 'undefined') console.error(e); } });
          (handlers['*'] || []).slice().forEach(function (fn) { try { fn(payload, ev); } catch (e) {} });
        });
      });
      if (typeof window !== 'undefined') {
        var kick = function () { if (sock && !sock.connected) sock.connect(); };
        window.addEventListener('online', kick);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(); });
      }
    }
    return {
      EVENTS: EVENTS,
      get status() { return status; },
      on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return function () { handlers[ev] = handlers[ev].filter(function (f) { return f !== fn; }); }; },
      onStatus: function (fn) { statusHandlers.push(fn); fn(status); },
      /* called on every (re)connect; arg = isFirstConnect. Use it to re-fetch full state after a gap. */
      onConnect: function (fn) { connectHandlers.push({ fn: fn }); },
      watchTicket: function (token) { watchToken = token; if (sock && sock.connected && token) sock.emit('ticket:watch', { token: token }); },
      close: function () { if (sock) sock.close(); },
      _sock: sock
    };
  }

  /* Poller: runs fn() on an adaptive interval (fast when the socket is down, slow safety net when it is up),
     never overlaps runs, pauses while the tab is hidden and runs immediately when it becomes visible. */
  function createPoller(o) {
    var running = false, timer = null, inFlight = false, stopped = true;
    function interval() { var online = o.isOnline ? o.isOnline() : false; return online ? (o.slowMs || 20000) : (o.fastMs || 5000); }
    function hidden() { return typeof document !== 'undefined' && document.hidden; }
    async function tick() {
      timer = null;
      if (stopped) return;
      if (!hidden() && !inFlight) { inFlight = true; try { await o.fn(); } catch (e) { /* caller handles errors */ } finally { inFlight = false; } }
      schedule();
    }
    function schedule() { if (stopped) return; clearTimeout(timer); timer = setTimeout(tick, interval()); }
    function onVis() { if (!hidden() && !stopped) { clearTimeout(timer); tick(); } }
    return {
      start: function (immediate) {
        if (!stopped) return; stopped = false;
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        if (immediate) tick(); else schedule();
      },
      stop: function () { stopped = true; clearTimeout(timer); timer = null; if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); },
      trigger: function () { if (stopped) return Promise.resolve(); clearTimeout(timer); return tick(); },
      reschedule: function () { schedule(); }
    };
  }
  return { createDeduper: createDeduper, createSocketClient: createSocketClient, createPoller: createPoller, EVENTS: EVENTS };
});
