'use strict';
// DB-backed sessions. Cookie holds a random sid; the table stores only SHA-256(sid).
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../database');

const COOKIE = config.session.cookieName;
const idleMs = () => config.session.idleMinutes * 60 * 1000;
const absMs = () => config.session.absoluteHours * 3600 * 1000;
const hashSid = (sid) => crypto.createHash('sha256').update(sid).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure: config.session.secureCookie };
}

function createSession(res, staffId = null) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const data = { csrf, createdAt: Date.now() };
  getDb().prepare('INSERT INTO sessions (sid, staff_id, data, expires_at) VALUES (?,?,?,?)')
    .run(hashSid(sid), staffId, JSON.stringify(data), new Date(Date.now() + idleMs()).toISOString());
  res.cookie(COOKIE, sid, cookieOptions());
  return { id: hashSid(sid), staffId, csrf, data };
}

function destroySession(req, res) {
  if (req.session) getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(req.session.id);
  req.session = null;
  req.staff = null;
  if (res) res.clearCookie(COOKIE, cookieOptions());
}

function destroyStaffSessions(staffId, exceptSid = null) {
  if (exceptSid) getDb().prepare('DELETE FROM sessions WHERE staff_id = ? AND sid != ?').run(staffId, exceptSid);
  else getDb().prepare('DELETE FROM sessions WHERE staff_id = ?').run(staffId);
}

function purgeExpired() {
  return getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()).changes;
}

const STAFF_SQL = `SELECT s.*, c.is_active AS clinic_active FROM staff s JOIN clinics c ON c.id = s.clinic_id WHERE s.id = ?`;

function loadSession(req, res, next) {
  req.session = null;
  req.staff = null;
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid || sid.length > 100) return next();
  const db = getDb();
  const id = hashSid(sid);
  const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(id);
  if (!row) return next();
  let data;
  try { data = JSON.parse(row.data); } catch { data = null; }
  const expires = Date.parse(row.expires_at);
  if (!data || !(expires > Date.now()) || Date.now() - (data.createdAt || 0) > absMs()) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(id);
    return next();
  }
  let staff = null;
  if (row.staff_id) {
    staff = db.prepare(STAFF_SQL).get(row.staff_id);
    if (!staff || !staff.is_active || !staff.clinic_active) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(id);
      return next();
    }
  }
  // sliding idle expiry (write at most once a minute)
  const newExpiry = Date.now() + idleMs();
  if (newExpiry - expires > 60 * 1000) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(new Date(newExpiry).toISOString(), id);
  }
  req.session = { id, staffId: row.staff_id, csrf: data.csrf, data };
  req.staff = staff;
  return next();
}

module.exports = {
  loadSession, createSession, destroySession, destroyStaffSessions, purgeExpired, parseCookies, hashSid,
};
