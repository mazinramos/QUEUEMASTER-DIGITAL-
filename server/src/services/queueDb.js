'use strict';
const crypto = require('crypto');

// ---- الوصول للـ DB: عبر server/src/database/index.js (حساب 1) أو حقن للاختبارات ----
let injected = null;
function setDb(db) { injected = db; }

function getDb() {
  if (injected) return injected;
  const m = require('../database'); // يدعم: module.exports = db | { getDb() } | { db }
  const db = typeof m.getDb === 'function' ? m.getDb() : (m.db || m);
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('queueDb: ../database must export a better-sqlite3 instance, { db } or { getDb() }');
  }
  return db;
}

// ---- الساعة (قابلة للحقن في الاختبارات) ----
let clock = () => new Date();
function setClock(fn) { clock = fn || (() => new Date()); }
function now() { return clock(); }
function nowIso() { return clock().toISOString(); }

// ---- التاريخ التشغيلي بمنطقة العيادة (Intl، لا يعتمد على توقيت السيرفر) ----
function businessDate(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// ---- التوكن: 32 بايت عشوائي، يُخزَّن SHA-256(token + pepper) فقط ----
let devWarned = false;
function pepper() {
  const p = process.env.TICKET_TOKEN_PEPPER || process.env.TOKEN_PEPPER;
  if (p && p.length >= 16) return p;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TICKET_TOKEN_PEPPER must be set in .env (min 16 chars). Never commit it.');
  }
  // تطوير فقط: قيمة config المؤقتة (عشوائية لكل تشغيل) => التوكنات القديمة تبطل بعد إعادة التشغيل
  try {
    const c = require('../config').ticketTokenPepper;
    if (c && c.length >= 16) {
      if (!devWarned) { devWarned = true; require('./queueLog').warn('TICKET_TOKEN_PEPPER not set: using an ephemeral dev pepper; tickets will not survive a restart'); }
      return c;
    }
  } catch (_) { /* لا config */ }
  throw new Error('TICKET_TOKEN_PEPPER must be set in .env (min 16 chars). Never commit it.');
}
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token) + pepper()).digest('hex');
}
function newPublicId() { return crypto.randomBytes(12).toString('base64url'); }
function uuid() { return crypto.randomUUID(); }

// مفتاح خدمة عام غير متسلسل (بدل رقم الـ DB في صفحات المريض)، حتمي من الـ pepper
function serviceKey(serviceId) {
  return crypto.createHmac('sha256', pepper()).update(`svc:${serviceId}`).digest('base64url').slice(0, 12);
}

function pad(n) { return String(n).padStart(3, '0'); }

module.exports = {
  setDb, getDb, setClock, now, nowIso, businessDate,
  newToken, hashToken, newPublicId, uuid, serviceKey, pad,
};
