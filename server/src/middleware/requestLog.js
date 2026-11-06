'use strict';
const crypto = require('crypto');
const logger = require('../utils/logger');

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

function requestLog(req, res, next) {
  const incoming = req.get('X-Request-Id');
  req.id = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    const status = res.statusCode;
    const fn = status >= 500 ? logger.error : status >= 400 ? logger.warn : logger.info;
    fn('request', {
      reqId: req.id, method: req.method, path: logger.safePath(req.originalUrl), status, ms,
      staffId: req.staff ? req.staff.id : undefined, clinicId: req.staff ? req.staff.clinic_id : undefined, ip: req.ip,
    });
  });
  next();
}
module.exports = { requestLog };
