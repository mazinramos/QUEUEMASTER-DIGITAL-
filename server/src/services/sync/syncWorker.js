'use strict';
// عامل sync_outbox -> sink (Firebase). السيرفر المحلي هو المرجع الوحيد؛ Firebase نسخة مرآة اختيارية.
//
// السياسات (موثقة):
//  - الترتيب: المعالجة بترتيب id تصاعدياً. فشل صف يحجب الصفوف اللاحقة لنفس الكيان فقط (clinic+entity+uid)
//    حتى ينجح أو يستنفد المحاولات (عندها يصبح failed ولا يحجب، لأن الصف التالي يحمل الحالة الكاملة).
//  - Idempotent: كل كتابة تحمل _version = id الصف المحلي (متزايد). الـ sink يتجاهل أي إصدار <= المخزن عنده،
//    فإعادة التشغيل/التكرار/وصول متأخر لا يغيّر شيئاً.
//  - التعارض: "المحلي يفوز". لا قراءة من Firebase إلى المحلي إطلاقاً. أي تعديل يدوي في Firebase يُستبدل
//    عند أول upsert لاحق لنفس الكيان. الحذف = tombstone (`_deleted:true`) حتى لا يُبعث بإعادة تشغيل قديمة.
const q = require('../queueDb');
const log = require('../queueLog');

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 10 * 60 * 1000;
const backoff = (n) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (n - 1));
const scrub = (e) => String(e || 'error').slice(0, 300);

const state = { mode: 'pending_integration', sinkName: null, lastError: null, lastSyncedAt: null, timer: null, nextTry: new Map(), noticed: false };

function pathFor(row) {
  const plural = { ticket: 'tickets' }[row.entity] || `${row.entity}s`;
  return `clinics/${row.clinic_id}/${plural}/${row.entity_uid}`;
}

async function processOnce({ sink, limit = 500 }) {
  const db = q.getDb();
  const rows = db.prepare(`SELECT * FROM sync_outbox WHERE status='pending' ORDER BY id LIMIT ?`).all(limit);
  const blocked = new Set();
  const out = { synced: 0, stale: 0, retried: 0, failed: 0, blocked: 0 };
  for (const r of rows) {
    const key = `${r.clinic_id}:${r.entity}:${r.entity_uid}`;
    if (blocked.has(key)) { out.blocked++; continue; }
    const wait = state.nextTry.get(r.id);
    if (wait && wait > Date.now()) { blocked.add(key); out.blocked++; continue; }
    try {
      const res = await sink.apply({
        path: pathFor(r), operation: r.operation, version: r.id,
        data: JSON.parse(r.payload), entity: r.entity, entityUid: r.entity_uid, clinicId: r.clinic_id,
      });
      db.prepare(`UPDATE sync_outbox SET status='synced', synced_at=?, last_error=NULL WHERE id=?`).run(q.nowIso(), r.id);
      state.nextTry.delete(r.id); state.lastSyncedAt = q.nowIso();
      if (res === 'stale') out.stale++; else out.synced++;
    } catch (e) {
      const attempts = r.attempts + 1;
      state.lastError = scrub(e && e.message);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE sync_outbox SET status='failed', attempts=?, last_error=? WHERE id=?`).run(attempts, state.lastError, r.id);
        state.nextTry.delete(r.id); out.failed++;
        log.warn('sync row permanently failed', { id: r.id });
      } else {
        db.prepare(`UPDATE sync_outbox SET attempts=?, last_error=? WHERE id=?`).run(attempts, state.lastError, r.id);
        state.nextTry.set(r.id, Date.now() + backoff(attempts));
        blocked.add(key); out.retried++;
      }
    }
  }
  return out;
}

// تحميل Firebase فقط عند وجود credentials؛ بدونها يبقى الطابور معلقاً بلا ادعاء أنه يعمل.
function loadFirestoreSink(env = process.env) {
  const credPath = env.FIREBASE_SERVICE_ACCOUNT_PATH || env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) return { sink: null, reason: 'FIREBASE_SERVICE_ACCOUNT_PATH is not set' };
  let admin;
  try { admin = require('firebase-admin'); } catch (_) { return { sink: null, reason: 'firebase-admin is not installed' }; }
  try {
    const cred = JSON.parse(require('fs').readFileSync(credPath, 'utf8'));
    const app = admin.apps && admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(cred) });
    return { sink: require('./firestoreSink').createFirestoreSink(app.firestore()), reason: null };
  } catch (e) { return { sink: null, reason: `invalid Firebase credentials: ${e.message}` }; }
}

function start({ sink, intervalMs = 5000, env = process.env } = {}) {
  if (state.timer) return state;
  let s = sink; let reason = null;
  if (!s) ({ sink: s, reason } = loadFirestoreSink(env));
  if (!s) {
    state.mode = 'pending_integration';
    if (!state.noticed) { log.warn(`sync: pending integration (${reason}); sync_outbox stays pending`); state.noticed = true; }
    return state;
  }
  state.mode = 'active'; state.sinkName = s.name || 'custom';
  let running = false;
  state.timer = setInterval(async () => {
    if (running) return; running = true;
    try { await processOnce({ sink: s }); } catch (e) { state.lastError = scrub(e.message); log.error('sync iteration failed', { message: e.message }); } finally { running = false; }
  }, intervalMs);
  if (state.timer.unref) state.timer.unref();
  return state;
}

function stop() { if (state.timer) clearInterval(state.timer); state.timer = null; state.mode = 'pending_integration'; state.sinkName = null; }

function status(clinicId) {
  const db = q.getDb();
  const c = (st) => db.prepare('SELECT COUNT(*) c FROM sync_outbox WHERE clinic_id=? AND status=?').get(clinicId, st).c;
  const oldest = db.prepare(`SELECT MIN(created_at) m FROM sync_outbox WHERE clinic_id=? AND status='pending'`).get(clinicId).m;
  return {
    mode: state.mode, // 'active' | 'pending_integration'
    firebaseConfigured: state.mode === 'active',
    sink: state.sinkName,
    pending: c('pending'), synced: c('synced'), failed: c('failed'),
    oldestPendingAt: oldest || null, lastSyncedAt: state.lastSyncedAt, lastError: state.lastError,
    conflictPolicy: 'local-wins; versioned idempotent writes (_version = local outbox id); deletes are tombstones',
  };
}

module.exports = { processOnce, start, stop, status, pathFor, loadFirestoreSink, MAX_ATTEMPTS, backoff, _state: state };
