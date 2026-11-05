'use strict';
// adapter HTTP عام بقالب (يناسب معظم مزودي SMS). الإعداد من .env:
//   SMS_HTTP_URL           مثال: https://api.provider.example/v1/messages   (قد يحوي {{to}} {{body}})
//   SMS_HTTP_METHOD        POST (افتراضي) | GET
//   SMS_HTTP_CONTENT_TYPE  application/json (افتراضي) | application/x-www-form-urlencoded
//   SMS_HTTP_HEADERS       JSON، مثال: {"Authorization":"Bearer XXXX"}
//   SMS_HTTP_BODY          قالب الجسم، مثال: {"to":"{{to}}","text":"{{body}}","from":"Clinic"}
//   SMS_HTTP_SUCCESS_REGEX (اختياري) يجب أن يطابق نص الاستجابة ليُعدّ نجاحاً
//   SMS_HTTP_ID_PATH       (اختياري) مسار نقطي في JSON الاستجابة لمعرّف الرسالة، مثال: data.id
//   SMS_HTTP_TIMEOUT_MS    10000
// الاستبدال: JSON => هروب JSON، form/url => encodeURIComponent.
module.exports = function createHttpAdapter(env = process.env, fetchImpl = globalThis.fetch) {
  const url = env.SMS_HTTP_URL;
  if (!url) throw new Error('SMS_HTTP_URL is required for the http SMS adapter');
  const method = (env.SMS_HTTP_METHOD || 'POST').toUpperCase();
  const ctype = env.SMS_HTTP_CONTENT_TYPE || 'application/json';
  const headers = Object.assign({}, env.SMS_HTTP_HEADERS ? JSON.parse(env.SMS_HTTP_HEADERS) : {});
  const tpl = env.SMS_HTTP_BODY || '';
  const okRe = env.SMS_HTTP_SUCCESS_REGEX ? new RegExp(env.SMS_HTTP_SUCCESS_REGEX) : null;
  const idPath = env.SMS_HTTP_ID_PATH || null;
  const timeout = Number(env.SMS_HTTP_TIMEOUT_MS) || 10000;

  const sub = (s, vars, mode) => String(s).replace(/\{\{(to|body)\}\}/g, (_, k) =>
    mode === 'json' ? JSON.stringify(String(vars[k])).slice(1, -1)
      : mode === 'url' ? encodeURIComponent(String(vars[k])) : String(vars[k]));

  return {
    name: 'http',
    async send({ to, body }) {
      const vars = { to, body };
      const isJson = ctype.includes('json');
      const reqUrl = sub(url, vars, 'url');
      const init = { method, headers: Object.assign({}, headers), signal: AbortSignal.timeout(timeout) };
      if (method !== 'GET') {
        init.headers['Content-Type'] = ctype;
        init.body = sub(tpl, vars, isJson ? 'json' : 'url');
      }
      try {
        const res = await fetchImpl(reqUrl, init);
        const text = await res.text();
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        if (okRe && !okRe.test(text)) return { ok: false, error: 'Provider response did not match success pattern' };
        let providerId;
        if (idPath) {
          try { providerId = idPath.split('.').reduce((o, k) => (o == null ? o : o[k]), JSON.parse(text)); } catch (_) { /* لا معرّف */ }
        }
        return { ok: true, providerId: providerId == null ? undefined : String(providerId) };
      } catch (e) {
        return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : (e.message || 'network error') };
      }
    },
  };
};
