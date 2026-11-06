'use strict';
/**
 * adsService — منطق الإعلانات (حساب 5).
 * كل الاستعلامات مقيدة بـ clinic_id. الـ DB والبث والمسارات تُحقن (للاختبار) وتُحل افتراضياً بتأخير.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { AdsError, safeUnlink, isValidStoredName } = require('./adsUpload');

/**
 * مجلد الرفع: مصدر الحقيقة الوحيد هو config.uploadsDir (نفسه الذي يخدم منه /media عند ح4)،
 * وإلا (config غير متاح في اختبارات معزولة) UPLOADS_DIR ثم server/uploads. يُحل عند الاستخدام لا عند التحميل.
 */
function resolveUploadsDir() {
  try { const c = require('../config'); if (c && c.uploadsDir) return c.uploadsDir; } catch (_) { /* معزول */ }
  return process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, '../../uploads');
}
const DEFAULT_UPLOADS_DIR = resolveUploadsDir(); // للتوافق؛ الخدمة الافتراضية تستعمل resolveUploadsDir() عند الإنشاء

/* ---------- wiring افتراضي (يُحل عند أول استخدام) ---------- */
function defaultGetDb() {
  const m = require('../database');
  if (typeof m.getDb === 'function') return m.getDb();
  if (m.db && typeof m.db.prepare === 'function') return m.db;
  if (typeof m.prepare === 'function') return m;
  throw new Error('server/src/database/index.js must export getDb() or db (better-sqlite3 handle)');
}
function defaultEmit(clinicId, event, payload) {
  const s = require('../sockets');
  if (typeof s.emitToClinic !== 'function') throw new Error('sockets/index.js must export emitToClinic');
  return s.emitToClinic(clinicId, event, payload);
}

/* ---------- التحقق من المدخلات ---------- */
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح').transform((v) => new Date(v).toISOString());

const boolish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(s)) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
  }
  return v;
}, z.boolean());

const displayIds = z.preprocess((v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (v.trim() === '' || v.trim() === 'null') return null;
    try { return JSON.parse(v); } catch (_) { return '__invalid__'; }
  }
  return v;
}, z.array(z.number().int().positive()).max(100).nullable());

const adSchema = z.object({
  title: z.string().trim().min(1, 'العنوان مطلوب').max(120),
  media_type: z.enum(['image', 'video', 'text']),
  body_text: z.string().trim().max(500).nullable(),
  duration_sec: z.coerce.number().int().min(3).max(300),
  priority: z.coerce.number().int().min(-1000).max(1000),
  starts_at: isoDate.nullable(),
  ends_at: isoDate.nullable(),
  is_active: boolish,
  display_ids: displayIds,
}).refine((d) => !d.starts_at || !d.ends_at || d.starts_at < d.ends_at, {
  message: 'تاريخ النهاية يجب أن يكون بعد البداية', path: ['ends_at'],
});

const CLEARABLE = new Set(['starts_at', 'ends_at']);
const FIELDS = ['title', 'media_type', 'body_text', 'duration_sec', 'priority', 'starts_at', 'ends_at', 'is_active', 'display_ids'];

/** يطبّع body قادم من multipart (نصوص): '' -> undefined، ويحذف أي حقل غير معروف. */
function pickBody(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const v = raw[k];
    // '' = حقل فارغ في نموذج multipart: يعني «امسح الجدولة» لتاريخي البداية/النهاية، وغير ذلك «لم يُرسل»
    out[k] = v === '' ? (CLEARABLE.has(k) ? null : undefined) : v;
  }
  return out;
}

function zodToError(e) {
  const issues = e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  return new AdsError(400, 'VALIDATION', issues[0] ? `${issues[0].field}: ${issues[0].message}` : 'بيانات غير صالحة', { issues });
}

/* ---------- الحالة والجدولة ---------- */
function computeStatus(row, nowIso) {
  if (!row.is_active) return 'inactive';
  if (row.starts_at && row.starts_at > nowIso) return 'scheduled';
  if (row.ends_at && row.ends_at <= nowIso) return 'expired';
  return 'active';
}

function parseDisplayIds(v) {
  if (v === null || v === undefined || v === '') return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch (_) { return null; }
}

function createAdsService({
  getDb = defaultGetDb,
  emit = defaultEmit,
  uploadsDir = resolveUploadsDir(),
  now = () => new Date(),
  logger = console,
} = {}) {
  const nowIso = () => now().toISOString();

  function toApi(row, at = nowIso()) {
    return {
      id: row.id,
      title: row.title,
      mediaType: row.media_type,
      url: row.file_path ? `/media/${row.file_path}` : null,
      bodyText: row.body_text,
      durationSec: row.duration_sec,
      priority: row.priority,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      isActive: !!row.is_active,
      displayIds: parseDisplayIds(row.display_ids),
      status: computeStatus(row, at),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowById(clinicId, id) {
    return getDb().prepare('SELECT * FROM advertisements WHERE id = ? AND clinic_id = ?').get(id, clinicId);
  }

  function requireRow(clinicId, id) {
    const row = rowById(clinicId, id);
    if (!row) throw new AdsError(404, 'NOT_FOUND', 'الإعلان غير موجود');
    return row;
  }

  function assertDisplaysBelong(clinicId, ids) {
    if (!ids || ids.length === 0) return;
    const db = getDb();
    const unique = [...new Set(ids)];
    const found = db
      .prepare(`SELECT COUNT(*) AS c FROM displays WHERE clinic_id = ? AND id IN (${unique.map(() => '?').join(',')})`)
      .get(clinicId, ...unique).c;
    if (found !== unique.length) throw new AdsError(400, 'VALIDATION', 'display_ids: شاشة غير موجودة في هذه العيادة');
  }

  function audit(db, { clinicId, staffId, ip, action, adId, details }) {
    db.prepare(
      'INSERT INTO audit_logs (clinic_id, staff_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(clinicId, staffId ?? null, action, 'advertisement', String(adId), JSON.stringify(details || {}), ip || null, nowIso());
  }

  /* ---------- القراءة ---------- */
  function list(clinicId, { status } = {}) {
    const at = nowIso();
    const rows = getDb()
      .prepare('SELECT * FROM advertisements WHERE clinic_id = ? ORDER BY priority DESC, id ASC')
      .all(clinicId)
      .map((r) => toApi(r, at));
    return status ? rows.filter((r) => r.status === status) : rows;
  }

  function get(clinicId, id) {
    return toApi(requireRow(clinicId, id));
  }

  /** الإعلانات النشطة الآن (للشاشات). displayId اختياري: يصفّي حسب الاستهداف. */
  function getActiveAds(clinicId, { displayId, at } = {}) {
    const t = at ? new Date(at).toISOString() : nowIso();
    return getDb()
      .prepare('SELECT * FROM advertisements WHERE clinic_id = ? ORDER BY priority DESC, id ASC')
      .all(clinicId)
      .filter((r) => computeStatus(r, t) === 'active')
      .map((r) => toApi(r, t))
      .filter((a) => displayId == null || a.displayIds === null || a.displayIds.includes(Number(displayId)));
  }

  function preview(clinicId, id) {
    const ad = get(clinicId, id);
    const reasons = {
      active: 'سيظهر الآن على الشاشات المستهدفة',
      scheduled: 'مجدول لوقت لاحق',
      expired: 'انتهت فترة العرض',
      inactive: 'متوقف يدوياً',
    };
    return { ad, activeNow: ad.status === 'active', note: reasons[ad.status], targets: ad.displayIds === null ? 'all' : ad.displayIds };
  }

  /* ---------- البث ---------- */
  function broadcast(clinicId) {
    try {
      const ads = getActiveAds(clinicId);
      emit(clinicId, 'advertisement:updated', { eventId: crypto.randomUUID(), ts: nowIso(), clinicId, ads });
      lastSignature.set(clinicId, signature(ads));
    } catch (e) {
      logger.error && logger.error('[ads] broadcast failed:', e.message);
    }
  }

  const signature = (ads) => JSON.stringify(ads.map((a) => [a.id, a.updatedAt]));
  const lastSignature = new Map();

  /** يُستدعى دورياً: يبث فقط إن تغيّر المجموعة النشطة بسبب الزمن (بدء/انتهاء جدولة). */
  function tick() {
    const db = getDb();
    const clinics = db.prepare('SELECT DISTINCT clinic_id FROM advertisements').all().map((r) => r.clinic_id);
    for (const id of clinics) {
      const sig = signature(getActiveAds(id));
      if (!lastSignature.has(id)) { lastSignature.set(id, sig); continue; }
      if (lastSignature.get(id) !== sig) broadcast(id);
    }
  }

  let timer = null;
  function startScheduler(intervalMs = 30000) {
    if (timer) return timer;
    try { tick(); } catch (e) { logger.error && logger.error('[ads] initial tick failed:', e.message); }
    timer = setInterval(() => {
      try { tick(); } catch (e) { logger.error && logger.error('[ads] tick failed:', e.message); }
    }, intervalMs);
    if (timer.unref) timer.unref();
    return timer;
  }
  function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

  /* ---------- الكتابة ---------- */
  function checkMediaRules(data, fileKind, hasExistingFile) {
    if (data.media_type === 'text') {
      if (fileKind) throw new AdsError(400, 'VALIDATION', 'media_type=text لا يقبل ملفاً');
      if (!data.body_text) throw new AdsError(400, 'VALIDATION', 'body_text: النص مطلوب لإعلان نصي');
      return;
    }
    if (fileKind) {
      if (fileKind !== data.media_type) throw new AdsError(400, 'VALIDATION', `نوع الملف (${fileKind}) لا يطابق media_type (${data.media_type})`);
    } else if (!hasExistingFile) {
      throw new AdsError(400, 'VALIDATION', 'file: الملف مطلوب لإعلان صورة/فيديو');
    }
  }

  function create(clinicId, actor, rawBody, stored) {
    // stored = نتيجة upload.commit() (الملف مُنقل بالفعل). عند أي فشل نحذفه.
    try {
      const parsed = adSchema.safeParse({
        priority: 0, duration_sec: 15, is_active: true, body_text: null, starts_at: null, ends_at: null, display_ids: null,
        ...stripUndefined(pickBody(rawBody)),
      });
      if (!parsed.success) throw zodToError(parsed.error);
      const d = parsed.data;
      checkMediaRules(d, stored && stored.kind, false);
      assertDisplaysBelong(clinicId, d.display_ids);

      const db = getDb();
      const ts = nowIso();
      const run = db.transaction(() => {
        const info = db.prepare(
          `INSERT INTO advertisements (clinic_id, title, media_type, file_path, body_text, duration_sec, priority,
             starts_at, ends_at, is_active, display_ids, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(clinicId, d.title, d.media_type, stored ? stored.storedName : null,
          d.media_type === 'text' ? d.body_text : null, d.duration_sec, d.priority, d.starts_at, d.ends_at,
          d.is_active ? 1 : 0, d.display_ids === null ? null : JSON.stringify(d.display_ids), ts, ts);
        audit(db, { clinicId, staffId: actor.id, ip: actor.ip, action: 'ad.create', adId: info.lastInsertRowid, details: { title: d.title, media_type: d.media_type } });
        return info.lastInsertRowid;
      });
      const id = run();
      broadcast(clinicId);
      return get(clinicId, Number(id));
    } catch (e) {
      if (stored) safeUnlink(stored.finalPath);
      throw e;
    }
  }

  function update(clinicId, id, actor, rawBody, stored) {
    try {
      const existing = requireRow(clinicId, id);
      const provided = stripUndefined(pickBody(rawBody));
      const base = {
        title: existing.title, media_type: existing.media_type, body_text: existing.body_text,
        duration_sec: existing.duration_sec, priority: existing.priority, starts_at: existing.starts_at,
        ends_at: existing.ends_at, is_active: !!existing.is_active, display_ids: parseDisplayIds(existing.display_ids),
      };
      const parsed = adSchema.safeParse({ ...base, ...provided });
      if (!parsed.success) throw zodToError(parsed.error);
      const d = parsed.data;
      const typeChanged = d.media_type !== existing.media_type;
      const keepsFile = !!existing.file_path && !typeChanged && d.media_type !== 'text';
      checkMediaRules(d, stored && stored.kind, keepsFile);
      assertDisplaysBelong(clinicId, d.display_ids);

      const newFile = stored ? stored.storedName : (keepsFile ? existing.file_path : null);
      const db = getDb();
      db.transaction(() => {
        db.prepare(
          `UPDATE advertisements SET title=?, media_type=?, file_path=?, body_text=?, duration_sec=?, priority=?,
             starts_at=?, ends_at=?, is_active=?, display_ids=?, updated_at=? WHERE id=? AND clinic_id=?`,
        ).run(d.title, d.media_type, newFile, d.media_type === 'text' ? d.body_text : null, d.duration_sec, d.priority,
          d.starts_at, d.ends_at, d.is_active ? 1 : 0, d.display_ids === null ? null : JSON.stringify(d.display_ids),
          nowIso(), id, clinicId);
        audit(db, { clinicId, staffId: actor.id, ip: actor.ip, action: 'ad.update', adId: id, details: { fields: Object.keys(provided), fileReplaced: !!stored } });
      })();
      if (existing.file_path && existing.file_path !== newFile) removeFile(existing.file_path);
      broadcast(clinicId);
      return get(clinicId, id);
    } catch (e) {
      if (stored) safeUnlink(stored.finalPath);
      throw e;
    }
  }

  function remove(clinicId, id, actor) {
    const existing = requireRow(clinicId, id);
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM advertisements WHERE id = ? AND clinic_id = ?').run(id, clinicId);
      audit(db, { clinicId, staffId: actor.id, ip: actor.ip, action: 'ad.delete', adId: id, details: { title: existing.title } });
    })();
    if (existing.file_path) removeFile(existing.file_path);
    broadcast(clinicId);
    return { deleted: true };
  }

  function removeFile(name) {
    if (!isValidStoredName(name)) return; // لا نحذف إلا أسماء أنشأناها نحن
    safeUnlink(path.join(uploadsDir, name));
  }

  return { list, get, getActiveAds, preview, create, update, remove, broadcast, tick, startScheduler, stopScheduler, uploadsDir };
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

module.exports = { createAdsService, computeStatus, adSchema, DEFAULT_UPLOADS_DIR, resolveUploadsDir };
