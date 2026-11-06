'use strict';
// لوج منظم (LOG_FORMAT=json|text, LOG_LEVEL). لا كلمات مرور ولا توكنات ولا أرقام هواتف:
//  - الحقول ذات الأسماء الحساسة تُحجب، وأجسام الطلبات لا تُسجَّل أصلاً.
//  - مسارات الطلب لا تحمل query string، وأي مقطع مسار يشبه توكناً/معرّفاً عشوائياً يُستبدل.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /pass|token|secret|phone|hash|authorization|cookie|csrf|pepper|enc_?key|otp|mobile/i;

let sink = null; // اختبارات: دالة تستقبل السطر النهائي
const level = () => LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const format = () => ((process.env.LOG_FORMAT || 'text').toLowerCase() === 'json' ? 'json' : 'text');
const silent = () => process.env.NODE_ENV === 'test' && !sink && !process.env.LOG_IN_TEST;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

// /api/public/tickets/Ab3…(43 حرفاً)?t=… -> /api/public/tickets/:id
function safePath(url) {
  const p = String(url || '').split('?')[0].split('#')[0].slice(0, 300);
  return p.split('/').map((seg) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
    return /^[A-Za-z0-9_-]{20,}$/.test(s) || /^\+?\d{7,}$/.test(s) ? ':id' : seg;
  }).join('/');
}

function write(lvl, msg, fields) {
  if (LEVELS[lvl] < level() || silent()) return;
  const rec = { ts: new Date().toISOString(), level: lvl, msg, ...(fields ? redact(fields) : {}) };
  let line;
  if (format() === 'json') line = JSON.stringify(rec);
  else {
    const { ts, level: l, msg: m, ...rest } = rec;
    const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    line = `${ts} ${l.toUpperCase().padEnd(5)} ${m}${extra ? ` ${extra}` : ''}`;
  }
  if (sink) return sink(line, rec);
  return (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

module.exports = {
  debug: (m, f) => write('debug', m, f), info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f),
  redact, safePath, _setSink: (fn) => { sink = fn; },
};
