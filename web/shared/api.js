/* QueueMaster REST client. Envelope: { ok:true, data } | { ok:false, error:{ code, message } }.
   - Sends/receives JSON, same-origin cookies (qm.sid).
   - Staff mutations carry X-CSRF-Token (fetched lazily from GET /api/auth/csrf, refreshed once on a CSRF/403 failure).
   - Network failures and timeouts become ApiError with code NETWORK / TIMEOUT (never a raw TypeError). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.createApi = api.createApi; root.QM.ApiError = api.ApiError; root.QM.api = api.createApi({}); }
})(typeof self !== 'undefined' ? self : this, function () {
  function ApiError(code, message, status, details) {
    this.name = 'ApiError'; this.code = code; this.message = message || code; this.status = status || 0; this.details = details || null;
  }
  ApiError.prototype = Object.create(Error.prototype); ApiError.prototype.constructor = ApiError;

  function createApi(opts) {
    opts = opts || {};
    var fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    var base = opts.baseUrl || '';
    var timeoutMs = opts.timeoutMs || 15000;
    var csrfToken = null, csrfPromise = null;
    var unauthHandlers = [];

    function qs(query) {
      if (!query) return '';
      var parts = [];
      Object.keys(query).forEach(function (k) { if (query[k] != null && query[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k])); });
      return parts.length ? '?' + parts.join('&') : '';
    }
    function onUnauthenticated(fn) { unauthHandlers.push(fn); }

    async function rawFetch(method, path, o) {
      if (!fetchFn) throw new ApiError('NETWORK', 'fetch unavailable', 0);
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs || timeoutMs) : null;
      var headers = { Accept: 'application/json' };
      var init = { method: method, headers: headers, credentials: 'same-origin', signal: ctrl && ctrl.signal };
      if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
      if (o.csrf) headers['X-CSRF-Token'] = o.csrf;
      var res;
      try { res = await fetchFn(base + path + qs(o.query), init); }
      catch (e) {
        if (e && e.name === 'AbortError') throw new ApiError('TIMEOUT', 'timeout', 0);
        throw new ApiError('NETWORK', 'network error', 0);
      } finally { if (timer) clearTimeout(timer); }
      var json = null, text = '';
      try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      if (json && json.ok === true) return json.data;
      if (json && json.ok === false && json.error) throw new ApiError(json.error.code || 'UNKNOWN', json.error.message, res.status, json.error.details);
      if (res.status === 401) throw new ApiError('UNAUTHENTICATED', 'unauthenticated', 401);
      if (res.status === 429) throw new ApiError('RATE_LIMITED', 'rate limited', 429);
      throw new ApiError(res.ok ? 'BAD_RESPONSE' : (res.status >= 500 ? 'INTERNAL' : 'UNKNOWN'), 'bad response', res.status);
    }

    async function getCsrf(force) {
      if (csrfToken && !force) return csrfToken;
      if (!csrfPromise || force) {
        csrfPromise = rawFetch('GET', '/api/auth/csrf', {}).then(function (d) { csrfToken = d && d.csrfToken; if (!csrfToken) throw new ApiError('BAD_RESPONSE', 'no csrf', 0); return csrfToken; })
          .finally(function () { csrfPromise = null; });
      }
      return csrfPromise;
    }
    function resetCsrf() { csrfToken = null; }
    /* the server rotates the CSRF token on login; use the one it returns instead of fetching again */
    function setCsrf(tok) { csrfToken = tok || null; }

    /* request(method, path, { query, body, csrf }) ; csrf:true for staff/session mutations */
    async function request(method, path, o) {
      o = o || {};
      var needCsrf = o.csrf != null ? o.csrf : false;
      var attempt = 0;
      for (;;) {
        var token = needCsrf ? await getCsrf(attempt > 0) : null;
        try { return await rawFetch(method, path, { query: o.query, body: o.body, csrf: token, timeoutMs: o.timeoutMs }); }
        catch (e) {
          if (e instanceof ApiError) {
            if (e.status === 403 && needCsrf && attempt === 0 && (e.code === 'CSRF' || e.code === 'FORBIDDEN' || e.code === 'CSRF_INVALID')) { attempt++; resetCsrf(); continue; }
            if (e.status === 401 && !o.silent401) unauthHandlers.slice().forEach(function (fn) { try { fn(e); } catch (x) {} });
          }
          throw e;
        }
      }
    }
    var api = {
      request: request, getCsrf: getCsrf, resetCsrf: resetCsrf, setCsrf: setCsrf, onUnauthenticated: onUnauthenticated,
      get: function (p, o) { return request('GET', p, o); },
      post: function (p, body, o) { return request('POST', p, Object.assign({ body: body === undefined ? {} : body }, o || {})); },
      put: function (p, body, o) { return request('PUT', p, Object.assign({ body: body }, o || {})); },
      del: function (p, o) { return request('DELETE', p, o || {}); }
    };
    return api;
  }
  return { createApi: createApi, ApiError: ApiError };
});
