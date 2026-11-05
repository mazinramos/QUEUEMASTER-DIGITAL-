'use strict';
const crypto = require('crypto');
const { fail } = require('../utils/respond');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Public patient API and display (own cookie) are not staff-session endpoints.
const EXEMPT_PREFIXES = ['/api/public/', '/api/display/'];

function csrfProtect(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const url = req.originalUrl.split('?')[0];
  if (EXEMPT_PREFIXES.some((p) => url.startsWith(p))) return next();
  const token = req.get('X-CSRF-Token');
  const expected = req.session && req.session.csrf;
  if (!token || !expected) return fail(res, 403, 'FORBIDDEN', 'Invalid CSRF token');
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return fail(res, 403, 'FORBIDDEN', 'Invalid CSRF token');
  }
  return next();
}
module.exports = { csrfProtect };
