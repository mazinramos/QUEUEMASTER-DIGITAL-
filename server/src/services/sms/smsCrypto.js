'use strict';
// تشفير رقم الهاتف AES-256-GCM. المفتاح: PHONE_ENC_KEY (64 خانة hex = 32 بايت) من .env (أو SMS_ENCRYPTION_KEY).
// الصيغة: "v1:" + base64url( iv(12) | tag(16) | ciphertext )
const crypto = require('crypto');

function key() {
  const k = process.env.PHONE_ENC_KEY || process.env.SMS_ENCRYPTION_KEY;
  if (!k || !/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('PHONE_ENC_KEY must be 64 hex chars (32 bytes) in .env');
  return Buffer.from(k, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function decrypt(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) throw new Error('bad ciphertext');
  const raw = Buffer.from(blob.slice(3), 'base64url');
  if (raw.length < 29) throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

function isConfigured() { return /^[0-9a-fA-F]{64}$/.test(process.env.PHONE_ENC_KEY || process.env.SMS_ENCRYPTION_KEY || ''); }

module.exports = { encrypt, decrypt, isConfigured };
