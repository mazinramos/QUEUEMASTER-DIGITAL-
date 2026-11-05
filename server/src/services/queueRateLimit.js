'use strict';
// محدّد معدل بسيط في الذاكرة (نافذة منزلقة) لمسارات المريض العامة. حساب 1 قد يضيف محدداً عاماً أيضاً.
const { QueueError, sendError } = require('./queueErrors');

function createLimiter({ windowMs, max, keyFn }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [k, arr] of hits) { const f = arr.filter((t) => t > cut); if (f.length) hits.set(k, f); else hits.delete(k); }
  }, Math.max(1000, windowMs));
  if (timer.unref) timer.unref();
  const mw = (req, res, next) => {
    const key = keyFn(req);
    const cut = Date.now() - windowMs;
    const arr = (hits.get(key) || []).filter((t) => t > cut);
    if (arr.length >= max) return sendError(res, new QueueError('RATE_LIMITED', 'Too many requests'));
    arr.push(Date.now()); hits.set(key, arr);
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}

module.exports = { createLimiter };
