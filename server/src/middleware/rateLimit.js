'use strict';
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { fail } = require('../utils/respond');

const handler = (req, res) => fail(res, 429, 'RATE_LIMITED', 'Too many requests, slow down');

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs, limit: config.rateLimit.apiMax,
  standardHeaders: true, legacyHeaders: false, handler,
});
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.loginWindowMs, limit: config.rateLimit.loginMax,
  standardHeaders: true, legacyHeaders: false, handler,
});
const strictLimiter = rateLimit({ // csrf bootstrap / setup: stop anonymous session spam
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, handler,
});
module.exports = { apiLimiter, loginLimiter, strictLimiter };
