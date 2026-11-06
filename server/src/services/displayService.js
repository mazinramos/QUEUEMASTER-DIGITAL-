'use strict';
/**
 * خدمة الشاشة (حساب 4): الإقران، الكوكي الموقّع، bootstrap، إدارة الشاشات وإعداداتها.
 * كل دالة تأخذ `db` (better-sqlite3) صراحةً ليسهل الاختبار؛ كل استعلام مقيّد بـ clinic_id.
 */
const crypto = require('crypto');
const path = require('path');

const COOKIE_NAME = 'qm.display';
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون 0/O/1/I
const PAIR_LENGTH = 8;

const DEFAULT_SETTINGS = Object.freeze({
  announce_lang: 'both',
  audio_enabled: 1,
  volume: 1.0,
  speech_rate: 0.9,
  speech_pitch: 1.0,
  repeat_count: 2,
  repeat_delay_ms: 2500,
});

const nowIso = () => new Date().toISOString();

/* ---------- الإقران ---------- */
function generatePairingCode() {
  let out = '';
  for (let i = 0; i < PAIR_LENGTH; i++) out += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
  return out;
}
function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[\s-]+/g, '');
}
function formatCode(code) {
  return code.length === PAIR_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}
function isValidCodeShape(code) {
  const c = normalizeCode(code);
  return c.length === PAIR_LENGTH && [...c].every((ch) => PAIR_ALPHABET.includes(ch));
}

/* ---------- الكوكي الموقّع ---------- */
let fallbackSecret = null;
function getSecret() {
  if (process.env.DISPLAY_COOKIE_SECRET) return process.env.DISPLAY_COOKIE_SECRET;
  try { // سر الجلسات من config حساب 1 (إلزامي في الإنتاج) مع فصل النطاق حتى لا يصلح كوكي الشاشة كسر عام
    const cfg = require('../config');
    if (cfg && cfg.sessionSecret) return crypto.createHash('sha256').update('qm.display:' + cfg.sessionSecret).digest('hex');
  } catch (e) { /* config غير متاح (اختبارات معزولة) */ }
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[display] لا يوجد DISPLAY_COOKIE_SECRET/SESSION_SECRET: استُخدم سر مؤقت، ستفقد الشاشات اقترانها عند إعادة تشغيل السيرفر.');
  }
  return fallbackSecret;
}
function signValue(displayId, pairingHash, secret) {
  return crypto.createHmac('sha256', secret).update(`${displayId}:${pairingHash}`).digest('hex');
}
/** قيمة الكوكي: <id>.<hmac>. تتغير بإعادة ضبط كود الإقران فيبطل القديم. */
function makeCookieValue(display, secret = getSecret()) {
  return `${display.id}.${signValue(display.id, display.pairing_code_hash, secret)}`;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
    }
  }
  return out;
}
/** يعيد صف الشاشة الفعّالة أو null. يُصدَّر ليستخدمه حساب 2 في مصادقة Socket.IO. */
function authenticateDisplay(db, cookieHeader, secret = getSecret()) {
  const raw = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const id = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isInteger(id) || id < 1 || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const row = db.prepare(
    `SELECT d.* FROM displays d JOIN clinics c ON c.id = d.clinic_id
     WHERE d.id = ? AND d.is_active = 1 AND c.is_active = 1`
  ).get(id);
  if (!row) return null;
  const expected = signValue(row.id, row.pairing_code_hash, secret);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

function findDisplayByCode(db, code) {
  if (!isValidCodeShape(code)) return null;
  return db.prepare(
    `SELECT d.* FROM displays d JOIN clinics c ON c.id = d.clinic_id
     WHERE d.pairing_code_hash = ? AND d.is_active = 1 AND c.is_active = 1`
  ).get(hashCode(code)) || null;
}

/* ---------- الوقت ---------- */
function businessDate(timezone, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/* ---------- تحويل الصفوف ---------- */
function mediaUrl(filePath) {
  return filePath ? `/media/${path.basename(String(filePath).replace(/\\/g, '/'))}` : null;
}
function settingsDto(row) {
  const s = Object.assign({}, DEFAULT_SETTINGS, row || {});
  return {
    announce_lang: s.announce_lang,
    audio_enabled: !!s.audio_enabled,
    volume: Number(s.volume),
    speech_rate: Number(s.speech_rate),
    speech_pitch: Number(s.speech_pitch),
    repeat_count: Number(s.repeat_count),
    repeat_delay_ms: Number(s.repeat_delay_ms),
  };
}
function ticketDto(r) {
  return {
    number: r.display_number,
    status: r.status,
    service: { prefix: r.service_prefix, name_ar: r.service_name_ar, name_en: r.service_name_en },
    counter: r.counter_number == null ? null : { number: r.counter_number, name_ar: r.counter_name_ar, name_en: r.counter_name_en, name: r.counter_name_ar },
    calledAt: r.called_at || null,
  };
}
function adDto(r) {
  let ids = null;
  if (r.display_ids) { try { const v = JSON.parse(r.display_ids); if (Array.isArray(v) && v.length) ids = v.map(Number); } catch { /* تجاهل */ } }
  return {
    id: r.id, title: r.title, mediaType: r.media_type,
    url: r.media_type === 'text' ? null : mediaUrl(r.file_path),
    bodyText: r.body_text || null, durationSec: r.duration_sec, priority: r.priority,
    startsAt: r.starts_at || null, endsAt: r.ends_at || null, displayIds: ids,
  };
}

const TICKET_SELECT = `
  SELECT t.display_number, t.status, t.called_at,
         s.prefix AS service_prefix, s.name_ar AS service_name_ar, s.name_en AS service_name_en,
         c.number AS counter_number, c.name_ar AS counter_name_ar, c.name_en AS counter_name_en
  FROM tickets t
  JOIN services s ON s.id = t.service_id
  LEFT JOIN counters c ON c.id = t.counter_id`;

/** الإعلانات الفعّالة الآن والموجّهة لهذه الشاشة، بترتيب الأولوية. */
function activeAds(db, display, now = new Date()) {
  const rows = db.prepare(
    `SELECT * FROM advertisements WHERE clinic_id = ? AND is_active = 1 ORDER BY priority DESC, id ASC`
  ).all(display.clinic_id);
  const t = now.getTime();
  return rows.map(adDto).filter((a) => {
    if (a.mediaType !== 'text' && !a.url) return false;
    if (a.mediaType === 'text' && !a.bodyText) return false;
    if (a.startsAt && Date.parse(a.startsAt) > t) return false;
    if (a.endsAt && Date.parse(a.endsAt) <= t) return false;
    if (a.displayIds && !a.displayIds.includes(display.id)) return false;
    return true;
  });
}

function getBootstrap(db, display, now = new Date()) {
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(display.clinic_id);
  const settings = settingsDto(db.prepare('SELECT * FROM display_settings WHERE display_id = ?').get(display.id));
  const bd = businessDate(clinic.timezone, now);
  const where = `WHERE t.clinic_id = ? AND t.business_date = ?`;
  const current = db.prepare(`${TICKET_SELECT} ${where} AND t.status IN ('called','serving') ORDER BY t.called_at DESC, t.id DESC`).all(clinic.id, bd).map(ticketDto);
  const next = db.prepare(`${TICKET_SELECT} ${where} AND t.status = 'waiting' ORDER BY t.priority DESC, t.issued_at ASC, t.seq_number ASC, t.id ASC LIMIT 3`).all(clinic.id, bd).map(ticketDto);
  const recent = db.prepare(`${TICKET_SELECT} ${where} AND t.called_at IS NOT NULL AND t.status IN ('called','serving','completed','skipped') ORDER BY t.called_at DESC, t.id DESC LIMIT 6`).all(clinic.id, bd).map(ticketDto);
  const waitingCount = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${where} AND t.status = 'waiting'`).get(clinic.id, bd).n;
  return {
    display: { id: display.id, name: display.name, clinicId: clinic.id },
    clinic: {
      id: clinic.id, name_ar: clinic.name_ar, name_en: clinic.name_en, logoUrl: mediaUrl(clinic.logo_path),
      address: clinic.address, phone: clinic.phone, email: clinic.email, timezone: clinic.timezone, language: clinic.default_language,
    },
    settings, current, next, recent, waitingCount,
    ads: activeAds(db, display, now),
    serverTime: now.toISOString(),
  };
}

/* ---------- إدارة الشاشات (أدمن) ---------- */
let auditIp = null; // يضبطه الراوتر لكل طلب (متزامن، better-sqlite3 بلا await)
function setAuditIp(ip) { auditIp = ip || null; }
function audit(db, clinicId, staffId, action, entityId, details) {
  db.prepare(`INSERT INTO audit_logs (clinic_id, staff_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(clinicId, staffId || null, action, 'display', String(entityId), details ? JSON.stringify(details) : null, auditIp, nowIso());
}

function uniqueCode(db) {
  for (let i = 0; i < 10; i++) {
    const code = generatePairingCode();
    if (!db.prepare('SELECT 1 FROM displays WHERE pairing_code_hash = ?').get(hashCode(code))) return code;
  }
  throw new Error('تعذر توليد كود إقران فريد');
}

function createDisplay(db, { clinicId, name, settings, staffId }) {
  const code = uniqueCode(db);
  const ts = nowIso();
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO displays (clinic_id, name, pairing_code_hash, is_active, created_at, updated_at) VALUES (?,?,?,1,?,?)`)
      .run(clinicId, name, hashCode(code), ts, ts);
    const id = Number(info.lastInsertRowid);
    const s = Object.assign({}, DEFAULT_SETTINGS, normalizeSettingsInput(settings || {}));
    db.prepare(`INSERT INTO display_settings (display_id, announce_lang, audio_enabled, volume, speech_rate, speech_pitch, repeat_count, repeat_delay_ms, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, s.announce_lang, s.audio_enabled, s.volume, s.speech_rate, s.speech_pitch, s.repeat_count, s.repeat_delay_ms, ts);
    audit(db, clinicId, staffId, 'display.create', id, { name });
    return id;
  });
  const id = tx();
  return { display: getDisplay(db, clinicId, id), pairingCode: formatCode(code) };
}

function normalizeSettingsInput(s) {
  const out = {};
  for (const k of Object.keys(s)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    out[k] = k === 'audio_enabled' ? (s[k] ? 1 : 0) : s[k];
  }
  return out;
}

function getDisplay(db, clinicId, id) {
  const d = db.prepare('SELECT id, clinic_id, name, is_active, created_at, updated_at FROM displays WHERE id = ? AND clinic_id = ?').get(id, clinicId);
  if (!d) return null;
  d.is_active = !!d.is_active;
  d.settings = settingsDto(db.prepare('SELECT * FROM display_settings WHERE display_id = ?').get(id));
  return d;
}
function listDisplays(db, clinicId) {
  return db.prepare('SELECT id FROM displays WHERE clinic_id = ? ORDER BY id').all(clinicId).map((r) => getDisplay(db, clinicId, r.id));
}
function updateSettings(db, clinicId, id, patch, staffId) {
  if (!getDisplay(db, clinicId, id)) return null;
  const clean = normalizeSettingsInput(patch);
  const keys = Object.keys(clean);
  const ts = nowIso();
  const tx = db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM display_settings WHERE display_id = ?').get(id);
    if (!exists) db.prepare('INSERT INTO display_settings (display_id, updated_at) VALUES (?, ?)').run(id, ts);
    if (keys.length) {
      db.prepare(`UPDATE display_settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE display_id = ?`)
        .run(...keys.map((k) => clean[k]), ts, id);
    }
    audit(db, clinicId, staffId, 'display.settings', id, clean);
  });
  tx();
  return getDisplay(db, clinicId, id);
}
function updateDisplay(db, clinicId, id, { name, is_active }, staffId) {
  if (!getDisplay(db, clinicId, id)) return null;
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
  if (sets.length) {
    db.prepare(`UPDATE displays SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND clinic_id = ?`).run(...vals, nowIso(), id, clinicId);
    audit(db, clinicId, staffId, 'display.update', id, { name, is_active });
  }
  return getDisplay(db, clinicId, id);
}
function resetPairing(db, clinicId, id, staffId) {
  if (!getDisplay(db, clinicId, id)) return null;
  const code = uniqueCode(db);
  db.prepare('UPDATE displays SET pairing_code_hash = ?, updated_at = ? WHERE id = ? AND clinic_id = ?').run(hashCode(code), nowIso(), id, clinicId);
  audit(db, clinicId, staffId, 'display.reset_pairing', id, null);
  return { display: getDisplay(db, clinicId, id), pairingCode: formatCode(code) };
}
function deleteDisplay(db, clinicId, id, staffId) {
  const d = getDisplay(db, clinicId, id);
  if (!d) return false;
  db.prepare('DELETE FROM displays WHERE id = ? AND clinic_id = ?').run(id, clinicId);
  audit(db, clinicId, staffId, 'display.delete', id, { name: d.name });
  return true;
}

module.exports = {
  COOKIE_NAME, DEFAULT_SETTINGS,
  generatePairingCode, normalizeCode, formatCode, hashCode, isValidCodeShape,
  makeCookieValue, parseCookies, authenticateDisplay, findDisplayByCode,
  businessDate, settingsDto, activeAds, getBootstrap, setAuditIp,
  createDisplay, getDisplay, listDisplays, updateSettings, updateDisplay, resetPairing, deleteDisplay,
};
