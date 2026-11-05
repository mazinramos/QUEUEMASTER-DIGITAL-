'use strict';
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function secret(name) {
  const v = process.env[name];
  if (v && v.length >= 16) return v;
  if (isProd) throw new Error(`${name} must be set (>=16 chars) in production`);
  // dev/test only: ephemeral random value
  return crypto.randomBytes(32).toString('hex');
}

const serverRoot = path.join(__dirname, '..', '..');
const dataDir = path.resolve(serverRoot, process.env.DATA_DIR || './data');

module.exports = {
  env,
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  sessionSecret: secret('SESSION_SECRET'),
  ticketTokenPepper: secret('TICKET_TOKEN_PEPPER'),
  phoneEncKey: process.env.PHONE_ENC_KEY || '',
  smsProvider: process.env.SMS_PROVIDER || 'none',
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'queuemaster.db'),
  uploadsDir: path.join(serverRoot, 'uploads'),
  webDir: path.resolve(serverRoot, '..', 'web'),
  session: {
    idleMinutes: parseInt(process.env.SESSION_IDLE_MIN || '30', 10),
    absoluteHours: 12,
    cookieName: 'qm.sid',
    secureCookie: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : (isProd && /^https:/i.test(process.env.BASE_URL || '')),
  },
  rateLimit: {
    loginMax: parseInt(process.env.LOGIN_RATE_MAX || '10', 10),
    loginWindowMs: 15 * 60 * 1000,
    apiMax: parseInt(process.env.API_RATE_MAX || '1200', 10),
    apiWindowMs: 60 * 1000,
    lockAfterFails: parseInt(process.env.LOCK_AFTER_FAILS || '5', 10),
    lockMinutes: parseInt(process.env.LOCK_MINUTES || '15', 10),
  },
  version: require('../../package.json').version,
};
