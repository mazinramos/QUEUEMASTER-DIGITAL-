'use strict';
// adapter تجريبي: لا يرسل شيئاً، يكتب في اللوج برقم مقنّع فقط.
const log = require('../../queueLog');
const crypto = require('crypto');

function mask(to) { const d = String(to).replace(/\D/g, ''); return `***${d.slice(-2)}`; }

module.exports = function createConsoleAdapter() {
  return {
    name: 'console',
    async send({ to, body }) {
      log.info(`[sms:console] to ${mask(to)} (${String(body).length} chars)`);
      return { ok: true, providerId: 'console-' + crypto.randomBytes(4).toString('hex') };
    },
  };
};
module.exports.mask = mask;
