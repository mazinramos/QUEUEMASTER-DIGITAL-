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
  session: { idleMinutes: 30, absoluteHours: 12, cookieName: 'qm.sid' },
  version: require('../../package.json').version,
};
