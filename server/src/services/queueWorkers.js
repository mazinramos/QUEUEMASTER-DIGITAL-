'use strict';
// نقطة تشغيل واحدة للعاملين الخلفيين (يستدعيها server.js — حساب 1):
//   const workers = require('./services/queueWorkers'); workers.startAll(); ... workers.stopAll();
const log = require('./queueLog');

function startAll(opts = {}) {
  try {
    const { createAdapter, providerName } = require('./sms');
    if (!require('./sms/smsCrypto').isConfigured()) log.warn('sms worker not started: PHONE_ENC_KEY is not set');
    else if (!opts.smsAdapter && providerName() === 'none') log.info('sms worker not started: SMS_PROVIDER=none');
    else require('./sms/smsWorker').start({ adapter: opts.smsAdapter || createAdapter(), intervalMs: opts.smsIntervalMs });
  } catch (e) { log.error('sms worker failed to start', { message: e.message }); }
  try { require('./sync/syncWorker').start({ sink: opts.syncSink, intervalMs: opts.syncIntervalMs }); }
  catch (e) { log.error('sync worker failed to start', { message: e.message }); }
}

function stopAll() {
  require('./sms/smsWorker').stop();
  require('./sync/syncWorker').stop();
}

module.exports = { startAll, stopAll };
