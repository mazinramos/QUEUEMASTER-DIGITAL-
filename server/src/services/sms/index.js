'use strict';
// اختيار الـ adapter: SMS_PROVIDER = none (افتراضي، معطّل) | console | http
function providerName(env = process.env) { return (env.SMS_PROVIDER || 'none').toLowerCase(); }
function createAdapter(env = process.env) {
  const p = providerName(env);
  if (p === 'none') return null;
  if (p === 'console') return require('./adapters/console')();
  if (p === 'http') return require('./adapters/http')(env);
  throw new Error(`Unknown SMS_PROVIDER: ${p}`);
}
module.exports = { createAdapter, providerName };
