'use strict';
/**
 * reportsService — إحصاءات لوحة التحكم والتقارير (حساب 5). للقراءة فقط، كل استعلام مقيد بـ clinic_id.
 * التواريخ = التاريخ التشغيلي (business_date) بتوقيت العيادة، شاملة الطرفين.
 * تعريفات:
 *   وقت الانتظار = called_at − issued_at (للتذاكر التي نودي عليها)
 *   وقت الخدمة   = completed_at − serving_at (للمكتملة)
 *   قيد الخدمة   = status ∈ {called, serving}
 * الدقائق تُقرَّب لـ 3 خانات في SQL لأن julianday يعطي كسوراً دقيقة تُخطئ حدود الفئات (30.0 ← 29.99999).
 * الأسبوع: ISO (الاثنين أول الأسبوع). القيم بالدقائق مقرّبة لخانة عشرية.
 */

class ReportsError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const MAX_RANGE_DAYS = 366;
const WAIT_SQL = `CASE WHEN called_at IS NOT NULL AND called_at >= issued_at THEN ROUND((julianday(called_at) - julianday(issued_at)) * 1440.0, 3) END`;
const SVC_SQL = `CASE WHEN status = 'completed' AND serving_at IS NOT NULL AND completed_at >= serving_at THEN ROUND((julianday(completed_at) - julianday(serving_at)) * 1440.0, 3) END`;
const BUCKETS = [[0, 5, '0-5'], [5, 10, '5-10'], [10, 20, '10-20'], [20, 30, '20-30'], [30, 60, '30-60'], [60, Infinity, '60+']];

const r1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function businessDate(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function hourIn(iso, timezone) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return Number(h);
}
function isoWeekStart(dateStr) { // الاثنين
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(dateStr, -dow);
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function createReportsService({ getDb, now = () => new Date(), env = process.env } = {}) {
  if (typeof getDb !== 'function') throw new Error('getDb is required');

  function clinicOf(clinicId) {
    const c = getDb().prepare('SELECT id, timezone FROM clinics WHERE id = ?').get(clinicId);
    if (!c) throw new ReportsError(404, 'NOT_FOUND', 'العيادة غير موجودة');
    return c;
  }
  const today = (clinic) => businessDate(now(), clinic.timezone);

  /** يحلل from/to/serviceId. الافتراضي: آخر defaultDays يوماً تنتهي اليوم. */
  function parseRange(clinicId, q = {}, defaultDays = 1) {
    const clinic = clinicOf(clinicId);
    const t = today(clinic);
    const to = q.to ? String(q.to) : t;
    const from = q.from ? String(q.from) : addDays(to, -(defaultDays - 1));
    if (!isRealDate(from) || !isRealDate(to)) throw new ReportsError(400, 'VALIDATION', 'from/to يجب أن تكون بصيغة YYYY-MM-DD وتاريخاً صحيحاً');
    if (from > to) throw new ReportsError(400, 'VALIDATION', 'from يجب ألا يتجاوز to');
    if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) throw new ReportsError(400, 'VALIDATION', `المدى الأقصى ${MAX_RANGE_DAYS} يوماً`);
    let serviceId = null;
    if (q.serviceId !== undefined && q.serviceId !== '') {
      serviceId = Number(q.serviceId);
      if (!Number.isInteger(serviceId) || serviceId <= 0) throw new ReportsError(400, 'VALIDATION', 'serviceId غير صالح');
      const ok = getDb().prepare('SELECT 1 FROM services WHERE id = ? AND clinic_id = ?').get(serviceId, clinicId);
      if (!ok) throw new ReportsError(404, 'NOT_FOUND', 'الخدمة غير موجودة');
    }
    return { clinic, from, to, serviceId, today: t };
  }

  const svcFilter = (serviceId) => (serviceId ? { sql: ' AND service_id = ?', args: [serviceId] } : { sql: '', args: [] });

  /* ---------- بطاقات اللوحة ---------- */
  function overview(clinicId, q = {}) {
    const clinic = clinicOf(clinicId);
    const date = q.date ? String(q.date) : today(clinic);
    if (!isRealDate(date)) throw new ReportsError(400, 'VALIDATION', 'date يجب أن تكون YYYY-MM-DD');
    const db = getDb();

    const c = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(status='waiting'),0) AS waiting,
        COALESCE(SUM(status IN ('called','serving')),0) AS inService,
        COALESCE(SUM(status='completed'),0) AS completed,
        COALESCE(SUM(status='skipped'),0) AS skipped,
        COALESCE(SUM(status='cancelled'),0) AS cancelled,
        AVG(${WAIT_SQL}) AS avgWait, AVG(${SVC_SQL}) AS avgSvc
      FROM tickets WHERE clinic_id = ? AND business_date = ?`).get(clinicId, date);

    const services = db.prepare(`SELECT s.id, s.name_ar, s.name_en, s.prefix, s.is_active AS isActive,
        COUNT(t.id) AS issued,
        COALESCE(SUM(t.status='waiting'),0) AS waiting,
        COALESCE(SUM(t.status IN ('called','serving')),0) AS inService,
        COALESCE(SUM(t.status='completed'),0) AS completed,
        COALESCE(SUM(t.status='skipped'),0) AS skipped,
        COALESCE(SUM(t.status='cancelled'),0) AS cancelled,
        AVG(${WAIT_SQL.replace(/called_at|issued_at/g, (m) => `t.${m}`)}) AS avgWait,
        AVG(${SVC_SQL.replace(/\b(status|serving_at|completed_at)\b/g, (m) => `t.${m}`)}) AS avgSvc
      FROM services s LEFT JOIN tickets t ON t.service_id = s.id AND t.clinic_id = s.clinic_id AND t.business_date = ?
      WHERE s.clinic_id = ? GROUP BY s.id ORDER BY s.display_order, s.id`).all(date, clinicId)
      .map((r) => ({ id: r.id, name_ar: r.name_ar, name_en: r.name_en, prefix: r.prefix, isActive: !!r.isActive, issued: r.issued, waiting: r.waiting, inService: r.inService, completed: r.completed, skipped: r.skipped, cancelled: r.cancelled, avgWaitMin: r1(r.avgWait), avgServiceMin: r1(r.avgSvc) }));

    const counters = db.prepare(`SELECT c.id, c.number, c.name_ar, c.name_en, c.is_active AS isActive,
        COALESCE(SUM(t.status='completed'),0) AS served,
        AVG(${SVC_SQL.replace(/\b(status|serving_at|completed_at)\b/g, (m) => `t.${m}`)}) AS avgSvc,
        (SELECT t2.display_number FROM tickets t2 WHERE t2.counter_id = c.id AND t2.clinic_id = c.clinic_id AND t2.business_date = ? AND t2.status IN ('called','serving') ORDER BY t2.called_at DESC LIMIT 1) AS currentTicket
      FROM counters c LEFT JOIN tickets t ON t.counter_id = c.id AND t.clinic_id = c.clinic_id AND t.business_date = ?
      WHERE c.clinic_id = ? GROUP BY c.id ORDER BY c.number`).all(date, date, clinicId)
      .map((r) => ({ id: r.id, number: r.number, name_ar: r.name_ar, name_en: r.name_en, isActive: !!r.isActive, served: r.served, avgServiceMin: r1(r.avgSvc), currentTicket: r.currentTicket || null }));

    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, issued: 0 }));
    for (const row of db.prepare('SELECT issued_at FROM tickets WHERE clinic_id = ? AND business_date = ?').all(clinicId, date)) {
      hourly[hourIn(row.issued_at, clinic.timezone)].issued += 1;
    }
    const last7 = daily(clinicId, { from: addDays(date, -6), to: date }).rows.map((d) => ({ date: d.date, issued: d.issued, completed: d.completed }));

    return {
      date, timezone: clinic.timezone,
      cards: { today: c.total, waiting: c.waiting, inService: c.inService, completed: c.completed, skipped: c.skipped, cancelled: c.cancelled, avgWaitMin: r1(c.avgWait), avgServiceMin: r1(c.avgSvc) },
      services, counters, hourly, last7Days: last7,
    };
  }

  /* ---------- تقارير الفترات ---------- */
  function daily(clinicId, q = {}) {
    const { from, to, serviceId } = parseRange(clinicId, q, 7);
    const f = svcFilter(serviceId);
    const got = new Map(getDb().prepare(`SELECT business_date AS date, COUNT(*) AS issued,
        COALESCE(SUM(status='completed'),0) AS completed, COALESCE(SUM(status='skipped'),0) AS skipped,
        COALESCE(SUM(status='cancelled'),0) AS cancelled, COALESCE(SUM(status='waiting'),0) AS waiting,
        AVG(${WAIT_SQL}) AS avgWait, AVG(${SVC_SQL}) AS avgSvc
      FROM tickets WHERE clinic_id = ? AND business_date BETWEEN ? AND ?${f.sql} GROUP BY business_date`).all(clinicId, from, to, ...f.args)
      .map((r) => [r.date, r]));
    const rows = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = got.get(d);
      rows.push({ date: d, issued: r ? r.issued : 0, completed: r ? r.completed : 0, skipped: r ? r.skipped : 0, cancelled: r ? r.cancelled : 0, waiting: r ? r.waiting : 0, avgWaitMin: r ? r1(r.avgWait) : null, avgServiceMin: r ? r1(r.avgSvc) : null });
    }
    return { from, to, rows };
  }

  /** تجميع الفترات من بيانات خام (مرجّحاً بعدد العينات الصحيح عبر استعلام ثانٍ). */
  function grouped(clinicId, q, keyFn, defaultDays) {
    const { from, to, serviceId } = parseRange(clinicId, q, defaultDays);
    const f = svcFilter(serviceId);
    const raw = getDb().prepare(`SELECT business_date AS date, status, ${WAIT_SQL} AS wait, ${SVC_SQL} AS svc
      FROM tickets WHERE clinic_id = ? AND business_date BETWEEN ? AND ?${f.sql}`).all(clinicId, from, to, ...f.args);
    const map = new Map();
    for (const r of raw) {
      const k = keyFn(r.date);
      let g = map.get(k);
      if (!g) { g = { period: k, issued: 0, completed: 0, skipped: 0, cancelled: 0, w: [0, 0], s: [0, 0] }; map.set(k, g); }
      g.issued += 1;
      if (r.status === 'completed') g.completed += 1;
      else if (r.status === 'skipped') g.skipped += 1;
      else if (r.status === 'cancelled') g.cancelled += 1;
      if (r.wait !== null) { g.w[0] += r.wait; g.w[1] += 1; }
      if (r.svc !== null) { g.s[0] += r.svc; g.s[1] += 1; }
    }
    const rows = [...map.values()].sort((a, b) => (a.period < b.period ? -1 : 1))
      .map((g) => ({ period: g.period, issued: g.issued, completed: g.completed, skipped: g.skipped, cancelled: g.cancelled, avgWaitMin: g.w[1] ? r1(g.w[0] / g.w[1]) : null, avgServiceMin: g.s[1] ? r1(g.s[0] / g.s[1]) : null }));
    return { from, to, rows };
  }
  const weekly = (clinicId, q = {}) => grouped(clinicId, q, isoWeekStart, 56);   // آخر 8 أسابيع
  const monthly = (clinicId, q = {}) => grouped(clinicId, q, (d) => d.slice(0, 7), 365);

  function summary(clinicId, q = {}) {
    const { from, to, serviceId } = parseRange(clinicId, q, 7);
    const f = svcFilter(serviceId);
    const c = getDb().prepare(`SELECT COUNT(*) AS issued, COALESCE(SUM(status='completed'),0) AS completed,
        COALESCE(SUM(status='skipped'),0) AS skipped, COALESCE(SUM(status='cancelled'),0) AS cancelled,
        AVG(${WAIT_SQL}) AS avgWait, AVG(${SVC_SQL}) AS avgSvc, COUNT(DISTINCT business_date) AS activeDays
      FROM tickets WHERE clinic_id = ? AND business_date BETWEEN ? AND ?${f.sql}`).get(clinicId, from, to, ...f.args);
    return { from, to, issued: c.issued, completed: c.completed, skipped: c.skipped, cancelled: c.cancelled, avgWaitMin: r1(c.avgWait), avgServiceMin: r1(c.avgSvc), activeDays: c.activeDays, avgPerActiveDay: c.activeDays ? r1(c.issued / c.activeDays) : null };
  }

  function services(clinicId, q = {}) {
    const { from, to } = parseRange(clinicId, q, 7);
    const rows = getDb().prepare(`SELECT s.id, s.name_ar, s.name_en, s.prefix, COUNT(t.id) AS issued,
        COALESCE(SUM(t.status='completed'),0) AS completed, COALESCE(SUM(t.status='skipped'),0) AS skipped,
        COALESCE(SUM(t.status='cancelled'),0) AS cancelled,
        AVG(${WAIT_SQL.replace(/called_at|issued_at/g, (m) => `t.${m}`)}) AS avgWait,
        AVG(${SVC_SQL.replace(/\b(status|serving_at|completed_at)\b/g, (m) => `t.${m}`)}) AS avgSvc
      FROM services s LEFT JOIN tickets t ON t.service_id = s.id AND t.clinic_id = s.clinic_id AND t.business_date BETWEEN ? AND ?
      WHERE s.clinic_id = ? GROUP BY s.id ORDER BY s.display_order, s.id`).all(from, to, clinicId)
      .map((r) => ({ id: r.id, name_ar: r.name_ar, name_en: r.name_en, prefix: r.prefix, issued: r.issued, completed: r.completed, skipped: r.skipped, cancelled: r.cancelled, avgWaitMin: r1(r.avgWait), avgServiceMin: r1(r.avgSvc) }));
    return { from, to, rows };
  }

  function waitingTimes(clinicId, q = {}) {
    const { clinic, from, to, serviceId } = parseRange(clinicId, q, 7);
    const f = svcFilter(serviceId);
    const raw = getDb().prepare(`SELECT issued_at, ${WAIT_SQL} AS wait FROM tickets
      WHERE clinic_id = ? AND business_date BETWEEN ? AND ? AND called_at IS NOT NULL${f.sql}`).all(clinicId, from, to, ...f.args)
      .filter((r) => r.wait !== null);
    const waits = raw.map((r) => r.wait).sort((a, b) => a - b);
    const sum = waits.reduce((a, b) => a + b, 0);
    const buckets = BUCKETS.map(([lo, hi, label]) => ({ label, count: waits.filter((w) => w >= lo && w < hi).length }));
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, sum: 0 }));
    for (const r of raw) { const h = byHour[hourIn(r.issued_at, clinic.timezone)]; h.count += 1; h.sum += r.wait; }
    return {
      from, to, samples: waits.length,
      avgMin: waits.length ? r1(sum / waits.length) : null, medianMin: r1(percentile(waits, 50)), p90Min: r1(percentile(waits, 90)), maxMin: waits.length ? r1(waits[waits.length - 1]) : null,
      buckets, byHour: byHour.map((h) => ({ hour: h.hour, count: h.count, avgMin: h.count ? r1(h.sum / h.count) : null })),
    };
  }

  function staff(clinicId, q = {}) {
    const { from, to } = parseRange(clinicId, q, 7);
    const db = getDb();
    const base = db.prepare(`SELECT s.id, s.full_name, s.username, s.role,
        COUNT(t.id) AS called, COALESCE(SUM(t.status='completed'),0) AS completed,
        AVG(${SVC_SQL.replace(/\b(status|serving_at|completed_at)\b/g, (m) => `t.${m}`)}) AS avgSvc
      FROM staff s LEFT JOIN tickets t ON t.called_by = s.id AND t.clinic_id = s.clinic_id AND t.business_date BETWEEN ? AND ?
      WHERE s.clinic_id = ? GROUP BY s.id ORDER BY s.full_name`).all(from, to, clinicId);
    const ev = new Map();
    for (const e of db.prepare(`SELECT e.staff_id, e.type, COUNT(*) AS n FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.clinic_id = ? AND t.business_date BETWEEN ? AND ? AND e.type IN ('skipped','cancelled','recalled') AND e.staff_id IS NOT NULL
      GROUP BY e.staff_id, e.type`).all(clinicId, from, to)) {
      if (!ev.has(e.staff_id)) ev.set(e.staff_id, {});
      ev.get(e.staff_id)[e.type] = e.n;
    }
    const rows = base.map((r) => ({ id: r.id, fullName: r.full_name, username: r.username, role: r.role, called: r.called, completed: r.completed, skipped: (ev.get(r.id) || {}).skipped || 0, cancelled: (ev.get(r.id) || {}).cancelled || 0, recalls: (ev.get(r.id) || {}).recalled || 0, avgServiceMin: r1(r.avgSvc) }));
    return { from, to, rows };
  }

  /* ---------- حالة المزامنة والرسائل (قراءة فقط؛ لا أرقام هواتف ولا حمولات) ---------- */
  const redact = (e) => (e == null ? null : String(e).replace(/\+?\d[\d\s-]{6,}\d/g, '***').slice(0, 200));
  function integrations(clinicId) {
    clinicOf(clinicId);
    const db = getDb();
    const counts = (table, statuses) => {
      const out = Object.fromEntries(statuses.map((x) => [x, 0]));
      for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} WHERE clinic_id = ? GROUP BY status`).all(clinicId)) out[r.status] = r.n;
      return out;
    };
    const setting = db.prepare("SELECT value FROM clinic_settings WHERE clinic_id = ? AND key = 'sms_enabled'").get(clinicId);
    const smsOldest = db.prepare("SELECT MIN(created_at) AS t FROM sms_outbox WHERE clinic_id = ? AND status = 'pending'").get(clinicId).t;
    const smsErr = db.prepare("SELECT last_error AS e, updated_at AS at FROM sms_outbox WHERE clinic_id = ? AND status = 'failed' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get(clinicId);
    const syncOldest = db.prepare("SELECT MIN(created_at) AS t FROM sync_outbox WHERE clinic_id = ? AND status = 'pending'").get(clinicId).t;
    const syncErr = db.prepare("SELECT last_error AS e, created_at AS at FROM sync_outbox WHERE clinic_id = ? AND status = 'failed' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get(clinicId);
    const lastSynced = db.prepare("SELECT MAX(synced_at) AS t FROM sync_outbox WHERE clinic_id = ? AND status = 'synced'").get(clinicId).t;
    const provider = env.SMS_PROVIDER || 'none';
    return {
      sms: { enabled: !!setting && ['1', 'true', 'on'].includes(String(setting.value).toLowerCase()), provider, providerConfigured: provider !== 'none', encryptionKeyConfigured: !!(env.PHONE_ENC_KEY || env.SMS_ENCRYPTION_KEY),
        counts: counts('sms_outbox', ['pending', 'sent', 'failed', 'expired']), oldestPendingAt: smsOldest, lastError: smsErr ? { message: redact(smsErr.e), at: smsErr.at } : null },
      sync: { credentialsDetected: !!(env.FIREBASE_PROJECT_ID || env.FIREBASE_SERVICE_ACCOUNT_PATH || env.GOOGLE_APPLICATION_CREDENTIALS),
        counts: counts('sync_outbox', ['pending', 'synced', 'failed']), oldestPendingAt: syncOldest, lastSyncedAt: lastSynced, lastError: syncErr ? { message: redact(syncErr.e), at: syncErr.at } : null },
    };
  }

  return { overview, integrations, summary, daily, weekly, monthly, services, waitingTimes, staff, parseRange, MAX_RANGE_DAYS };
}

module.exports = { createReportsService, ReportsError, isRealDate, isoWeekStart, businessDate };
