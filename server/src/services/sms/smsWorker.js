'use strict';
// عامل معالجة sms_outbox: إعادة محاولة تصاعدية + حذف الأرقام بعد purge_after. فشل الرسالة لا يمسّ التذكرة.
const q = require('../queueDb');
const log = require('../queueLog');
const store = require('./smsStore');
const { decrypt } = require('./smsCrypto');

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const LEASE_MS = 60 * 1000; // حجز الصف أثناء الإرسال

const backoff = (attempts) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
const scrub = (e) => String(e || 'error').replace(/\+?\d[\d\s-]{6,}\d/g, '[num]').slice(0, 200); // لا أرقام هواتف في last_error

async function processOnce({ adapter, batch = 20 } = {}) {
  const db = q.getDb();
  const purged = store.purgeExpired(db);
  const nowD = q.now();
  const at = nowD.toISOString();
  const rows = db.prepare(`SELECT * FROM sms_outbox WHERE status='pending' AND phone_encrypted<>''
    AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY id LIMIT ?`).all(at, batch);
  const out = { purged, sent: 0, retried: 0, failed: 0 };
  for (const r of rows) {
    const claim = db.prepare(`UPDATE sms_outbox SET next_attempt_at=?, updated_at=? WHERE id=? AND status='pending' AND attempts=?`)
      .run(new Date(nowD.getTime() + LEASE_MS).toISOString(), at, r.id, r.attempts);
    if (claim.changes !== 1) continue;
    let res;
    try {
      res = await adapter.send({ to: decrypt(r.phone_encrypted), body: r.body });
    } catch (e) { res = { ok: false, error: e && e.message }; }
    const attempts = r.attempts + 1;
    const done = q.nowIso();
    if (res && res.ok) {
      db.prepare(`UPDATE sms_outbox SET status='sent', attempts=?, provider=?, last_error=NULL, next_attempt_at=NULL, updated_at=? WHERE id=?`)
        .run(attempts, adapter.name + (res.providerId ? `:${res.providerId}` : ''), done, r.id);
      out.sent++;
    } else if (attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE sms_outbox SET status='failed', attempts=?, last_error=?, provider=?, next_attempt_at=NULL, updated_at=? WHERE id=?`)
        .run(attempts, scrub(res && res.error), adapter.name, done, r.id);
      out.failed++; log.warn('sms permanently failed', { id: r.id });
    } else {
      db.prepare(`UPDATE sms_outbox SET attempts=?, last_error=?, provider=?, next_attempt_at=?, updated_at=? WHERE id=?`)
        .run(attempts, scrub(res && res.error), adapter.name, new Date(q.now().getTime() + backoff(attempts)).toISOString(), done, r.id);
      out.retried++;
    }
  }
  return out;
}

let timer = null;
function start({ adapter, intervalMs = 5000 }) {
  if (timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return; running = true;
    try { await processOnce({ adapter }); } catch (e) { log.error('sms worker iteration failed', { message: e.message }); } finally { running = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { processOnce, start, stop, MAX_ATTEMPTS, backoff };
