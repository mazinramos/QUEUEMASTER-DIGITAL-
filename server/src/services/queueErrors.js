'use strict';
// أخطاء المنطق الداخلي. تُحوَّل إلى { ok:false, error:{ code, message } } في الراوترات.
const STATUS = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  FORBIDDEN_SERVICE: 403,
  NOT_FOUND: 404,
  QUEUE_EMPTY: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  ALREADY_CALLED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

class QueueError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'QueueError';
    this.code = code;
    this.status = STATUS[code] || 500;
    if (extra) this.extra = extra;
  }
}

function sendError(res, err) {
  if (err instanceof QueueError) {
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
  }
  // لا نسرّب تفاصيل داخلية، ولا نكتب أي توكن في اللوج
  require('./queueLog').error('unhandled error', { name: err && err.name, message: err && err.message });
  return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Internal error' } });
}

module.exports = { QueueError, sendError, STATUS };
