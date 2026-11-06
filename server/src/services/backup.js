'use strict';
// نسخ احتياطي متسق لـ SQLite أثناء التشغيل عبر db.backup() (لا نسخ ملف خام: WAL قد يكون غير مكتمل).
// الملفات: DATA_DIR/backups/qm-YYYYMMDD-HHmm.db  (وقت UTC). الاستعادة: node src/database/restore.js (والسيرفر متوقف).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { getDb } = require('../database');

const NAME_RE = /^qm-\d{8}-\d{4}(?:-\d{1,3})?\.db$/;
const NAME_RE_PARTS = /^qm-(\d{8}-\d{4})(?:-(\d{1,3}))?\.db$/;
const backupsDir = () => path.join(config.dataDir, 'backups');
const keepCount = () => Math.max(1, parseInt(process.env.BACKUP_KEEP || '7', 10) || 7);
const intervalMs = () => Math.max(0.05, Number(process.env.BACKUP_INTERVAL_HOURS) || 24) * 3600 * 1000;
const enabled = () => String(process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';

const isValidName = (n) => typeof n === 'string' && NAME_RE.test(n);

function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// يفتح النسخة للقراءة فقط ويفحص السلامة والمخطط
function verifyBackup(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    const fk = db.pragma('foreign_key_check').length;
    const hasSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='clinics'").get();
    const tickets = hasSchema ? db.prepare('SELECT COUNT(*) c FROM tickets').get().c : 0;
    return { ok: integrity === 'ok' && fk === 0 && hasSchema, integrity, fkViolations: fk, tickets };
  } catch (e) { // ملف ليس قاعدة SQLite أصلاً (تالف/مبتور) => غير صالح بدل رمي استثناء
    return { ok: false, integrity: e.message, fkViolations: -1, tickets: 0 };
  } finally { if (db) db.close(); }
}

function listBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  // الأحدث أولاً: الترتيب بالاسم (وقت UTC ثم رقم التكرار داخل نفس الدقيقة) لا بوقت الملف
  const order = (n) => { const m = NAME_RE_PARTS.exec(n); return [m[1], Number(m[2] || 1)]; };
  return fs.readdirSync(dir).filter(isValidName).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
  }).sort((a, b) => {
    const [sa, na] = order(a.name); const [sb, nb] = order(b.name);
    return sa === sb ? nb - na : (sa < sb ? 1 : -1);
  });
}

function applyRetention(keep = keepCount()) {
  const removed = [];
  for (const b of listBackups().slice(keep)) {
    try { fs.unlinkSync(path.join(backupsDir(), b.name)); removed.push(b.name); } catch { /* ignore */ }
  }
  return removed;
}

// اسم تصاعدي دائماً: أكبر نسخة موجودة (بالوقت ثم الرقم) + 1، فلا تأخذ نسخة جديدة اسماً "أقدم" من نسخ قائمة
// (وإلا تحذفها سياسة الاحتفاظ فوراً). يحمي أيضاً من رجوع ساعة النظام للخلف.
function nextName() {
  let st = stamp(); let seq = 1;
  const newest = listBackups()[0];
  if (newest) {
    const m = NAME_RE_PARTS.exec(newest.name); const ns = m[1]; const nseq = Number(m[2] || 1);
    if (ns >= st) { st = ns; seq = nseq + 1; }
  }
  if (seq > 999) throw new Error('too many backups in the same minute');
  return seq === 1 ? `qm-${st}.db` : `qm-${st}-${seq}.db`;
}

const timeoutMs = () => Math.max(1000, Number(process.env.BACKUP_TIMEOUT_MS) || 120000);
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`backup timed out after ${ms}ms`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

let running = null;
async function createBackup({ db = getDb(), reason = 'manual' } = {}) {
  if (running) return running; // طلبان متزامنان = نسخة واحدة
  running = withTimeout((async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = nextName();
    const target = path.join(dir, name);
    const tmp = `${target}.partial`;
    try {
      await db.backup(tmp);
      fs.renameSync(tmp, target);
      const check = verifyBackup(target);
      if (!check.ok) {
        fs.renameSync(target, `${target}.corrupt`); // لا يُحتسب نسخة صالحة ولا يظهر في القائمة
        throw new Error(`backup failed integrity check (${check.integrity})`);
      }
      const removed = applyRetention();
      const st = fs.statSync(target);
      return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), integrity: check.integrity, tickets: check.tickets, removed, reason };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already moved */ }
    }
  })(), timeoutMs()).finally(() => { running = null; });
  return running;
}

// تنزيل آمن: الاسم يجب أن يطابق النمط حرفياً (لا مسارات)، والملف يجب أن يقع داخل مجلد النسخ
function resolveBackupPath(name) {
  if (!isValidName(name)) return null;
  const dir = path.resolve(backupsDir());
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== dir || !fs.existsSync(full)) return null;
  return full;
}

let timer = null;
function startScheduler({ log = console, intervalMs: every, allowMemory = false } = {}) {
  if (timer || !enabled() || (config.dbPath === ':memory:' && !allowMemory)) return false;
  timer = setInterval(() => {
    createBackup({ reason: 'scheduled' })
      .then((r) => log.log && log.log(`[backup] ${r.name} ok (${r.sizeBytes} bytes, removed ${r.removed.length})`))
      .catch((e) => (log.error || console.error)('[backup] scheduled backup failed:', e.message));
  }, every || intervalMs());
  timer.unref();
  return true;
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { createBackup, listBackups, applyRetention, verifyBackup, resolveBackupPath, isValidName, startScheduler, stopScheduler, backupsDir, NAME_RE };

if (require.main === module) {
  createBackup({ reason: 'cli' }).then((r) => { console.log(JSON.stringify(r, null, 2)); require('../database').close(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
