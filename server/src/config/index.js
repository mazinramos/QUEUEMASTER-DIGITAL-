'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

const serverRoot = path.join(__dirname, '..', '..');
const dataDir = path.resolve(serverRoot, process.env.DATA_DIR || './data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'queuemaster.db');
const secrets = require('./secrets').resolveSecrets({ env, dataDir, memoryDb: dbPath === ':memory:' });

const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false').toLowerCase();
if (!['auto', 'true', 'false'].includes(COOKIE_SECURE)) {
  throw new Error(`COOKIE_SECURE must be auto|true|false (got "${process.env.COOKIE_SECURE}")`);
}

module.exports = {
  env,
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  sessionSecret: secrets.SESSION_SECRET,
  ticketTokenPepper: secrets.TICKET_TOKEN_PEPPER,
  phoneEncKey: secrets.PHONE_ENC_KEY,
  smsProvider: process.env.SMS_PROVIDER || 'none',
  dataDir,
  dbPath,
  uploadsDir: path.join(serverRoot, 'uploads'),
  webDir: path.resolve(serverRoot, '..', 'web'),
  session: {
    idleMinutes: parseInt(process.env.SESSION_IDLE_MIN || '30', 10),
    absoluteHours: 12,
    cookieName: 'qm.sid',
    // false (افتراضي، شبكة العيادة HTTP) | auto (Secure فقط إن كان الطلب HTTPS) | true (HTTPS دائماً)
    secureCookie: COOKIE_SECURE,
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
