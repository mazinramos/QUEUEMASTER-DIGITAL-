'use strict';
// حساب الانتظار + اللقطات + تحويل الصفوف لشكل آمن للعرض. للقراءة فقط.

// ترتيب الطابور الموحد: priority ثم الأقدم إصداراً ثم seq. (داخل الخدمة الواحدة = priority ثم seq)
const ORDER_SQL = 't.priority DESC, t.issued_at ASC, t.seq_number ASC, t.id ASC';

const WAIT_SAMPLE_SIZE = 20; // N: آخر تذاكر مكتملة تُحسب منها المتوسط
const WAIT_MIN_SAMPLES = 3;  // أقل عدد عينات لاعتماد المتوسط الفعلي

function aheadOf(db, t) {
  if (t.status !== 'waiting') return 0;
  return db.prepare(`SELECT COUNT(*) AS c FROM tickets
    WHERE clinic_id=? AND service_id=? AND business_date=? AND status='waiting' AND id<>?
      AND (priority>? OR (priority=? AND (issued_at<? OR (issued_at=? AND seq_number<?))))`).get(
    t.clinic_id, t.service_id, t.business_date, t.id,
    t.priority, t.priority, t.issued_at, t.issued_at, t.seq_number).c;
}

// متوسط زمن الخدمة الفعلي (دقائق) من آخر N تذاكر مكتملة؛ null إن لم يكفِ.
function avgServiceMinutes(db, clinicId, serviceId) {
  const rows = db.prepare(`SELECT serving_at, completed_at FROM tickets
    WHERE clinic_id=? AND service_id=? AND status='completed' AND serving_at IS NOT NULL AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT ?`).all(clinicId, serviceId, WAIT_SAMPLE_SIZE);
  const mins = rows
    .map((r) => (Date.parse(r.completed_at) - Date.parse(r.serving_at)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  if (mins.length < WAIT_MIN_SAMPLES) return null;
  return mins.reduce((a, b) => a + b, 0) / mins.length;
}

// الزمن المقدّر = (من قبلك × متوسط الخدمة) ÷ عدد الشبابيك النشطة المرتبطة بالخدمة (≥1).
// المتوسط: الفعلي إن كفى، وإلا est_duration_min، وإلا null.
function estimateWaitMin(db, t, ahead) {
  const svc = db.prepare('SELECT est_duration_min FROM services WHERE id=? AND clinic_id=?').get(t.service_id, t.clinic_id);
  let per = avgServiceMinutes(db, t.clinic_id, t.service_id);
  if (per == null && svc && Number.isFinite(svc.est_duration_min) && svc.est_duration_min > 0) per = svc.est_duration_min;
  if (per == null) return null;
  const counters = db.prepare(`SELECT COUNT(*) AS c FROM counter_services cs
    JOIN counters c ON c.id=cs.counter_id AND c.is_active=1
    WHERE cs.service_id=? AND c.clinic_id=?`).get(t.service_id, t.clinic_id).c;
  return Math.ceil((ahead * per) / Math.max(1, counters));
}

function serviceOf(db, t) {
  return db.prepare('SELECT id, name_ar, name_en, prefix FROM services WHERE id=?').get(t.service_id);
}
function counterOf(db, id) {
  if (!id) return null;
  return db.prepare('SELECT id, number, name_ar, name_en FROM counters WHERE id=?').get(id);
}

// الشكل العام (بدون أي ID داخلي) — لـ socket وللمريض
function brief(db, t) {
  const s = serviceOf(db, t);
  return { number: t.display_number, service: s ? s.name_ar : null, serviceEn: s ? s.name_en : null, status: t.status };
}
function counterBrief(c) {
  return c ? { number: c.number, name: c.name_ar, nameEn: c.name_en } : null;
}

// لقطة كاملة لـ queue:updated
function snapshot(db, clinic, serviceKeyFn, today) {
  const clinicId = clinic.id;
  const services = db.prepare('SELECT id FROM services WHERE clinic_id=? AND is_active=1 ORDER BY display_order, id').all(clinicId)
    .map((s) => ({
      key: serviceKeyFn(s.id),
      waiting: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE clinic_id=? AND service_id=? AND business_date=? AND status='waiting'`)
        .get(clinicId, s.id, today).c,
    }));
  const current = db.prepare(`SELECT t.* FROM tickets t WHERE t.clinic_id=? AND t.business_date=? AND t.status IN ('called','serving')
    ORDER BY COALESCE(t.called_at, t.issued_at) DESC, t.id DESC LIMIT 20`).all(clinicId, today)
    .map((t) => Object.assign(brief(db, t), { counter: counterBrief(counterOf(db, t.counter_id)) }));
  const next = db.prepare(`SELECT t.* FROM tickets t WHERE t.clinic_id=? AND t.business_date=? AND t.status='waiting'
    ORDER BY ${ORDER_SQL} LIMIT 10`).all(clinicId, today).map((t) => brief(db, t));
  return { services, current, next };
}

module.exports = {
  ORDER_SQL, WAIT_SAMPLE_SIZE, WAIT_MIN_SAMPLES,
  aheadOf, avgServiceMinutes, estimateWaitMin, serviceOf, counterOf, brief, counterBrief, snapshot,
};
