'use strict';
const ok = (res, data = null, status = 200) => res.status(status).json({ ok: true, data });
const fail = (res, status, code, message, details) => {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ ok: false, error });
};
// wrap async route handlers
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { ok, fail, wrap };
