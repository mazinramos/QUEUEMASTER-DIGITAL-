'use strict';
// لوجر بسيط يحجب أي توكن تذكرة قبل الكتابة (قاعدة: التوكن الخام لا يظهر في اللوج).
// مُصدَّر أيضاً: redact() ليستخدمه لوجر الطلبات (حساب 1) لحجب /tickets/<token> و ?t=<token>.
const TOKEN_RE = /[A-Za-z0-9_-]{43}/g; // 32 بايت base64url = 43 حرفاً

function redact(value) {
  if (value == null) return value;
  let s = typeof value === 'string' ? value : safeStringify(value);
  s = s.replace(/(\/tickets\/)[^/?#\s"']+/g, '$1[redacted]')
       .replace(/([?&]t=)[^&#\s"']+/g, '$1[redacted]')
       .replace(TOKEN_RE, '[redacted-token]');
  return s;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function emit(level, msg, meta) {
  if (process.env.QM_SILENT === '1') return;
  const line = `[queue:${level}] ${redact(msg)}${meta ? ' ' + redact(meta) : ''}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

module.exports = {
  redact,
  info: (m, x) => emit('info', m, x),
  warn: (m, x) => emit('warn', m, x),
  error: (m, x) => emit('error', m, x),
};
