'use strict';
// استعادة نسخة احتياطية. CLI فقط والسيرفر متوقف:
//   node src/database/restore.js <اسم-النسخة|مسار> --yes
//   node src/database/restore.js --list
// قبل الاستبدال تُؤخذ نسخة أمان من القاعدة الحالية: DATA_DIR/backups/pre-restore-<وقت>.db
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

function serverIsRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function restore(source, { force = false } = {}) {
  const config = require('../config');
  const backup = require('../services/backup');
  const dbPath = config.dbPath;
  if (dbPath === ':memory:') throw new Error('Cannot restore an in-memory database');

  let src = source;
  if (backup.isValidName(source)) src = path.join(backup.backupsDir(), source);
  src = path.resolve(src);
  if (!fs.existsSync(src)) throw new Error(`Backup file not found: ${src}`);

  if (!force && (await serverIsRunning(config.port))) {
    throw new Error(`A server is answering on port ${config.port}. Stop it first (restore must run with the server stopped).`);
  }
  const check = backup.verifyBackup(src);
  if (!check.ok) throw new Error(`Backup is not valid (integrity=${check.integrity}, fkViolations=${check.fkViolations}). Nothing was changed.`);

  let safety = null;
  if (fs.existsSync(dbPath)) {
    fs.mkdirSync(backup.backupsDir(), { recursive: true });
    safety = path.join(backup.backupsDir(), `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    const cur = new Database(dbPath, { fileMustExist: true });
    try { await cur.backup(safety); } finally { cur.close(); }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restoring`;
  fs.copyFileSync(src, tmp);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* none */ } }
  fs.renameSync(tmp, dbPath);
  const after = backup.verifyBackup(dbPath);
  if (!after.ok) throw new Error('Restored database failed verification; your previous data is at ' + safety);
  return { restoredFrom: src, safetyCopy: safety, tickets: after.tickets };
}

module.exports = { restore };

if (require.main === module) {
  const args = process.argv.slice(2);
  const backup = require('../services/backup');
  if (args.includes('--list') || !args.length) {
    const items = backup.listBackups();
    console.log(items.length ? items.map((b) => `${b.name}  ${b.createdAt}  ${b.sizeBytes} bytes`).join('\n') : 'No backups found in ' + backup.backupsDir());
    console.log('\nUsage: node src/database/restore.js <backup-name|path> --yes   (server must be stopped)');
    process.exit(0);
  }
  if (!args.includes('--yes')) {
    console.error('This REPLACES the current database. Re-run with --yes to confirm (a safety copy is made first).');
    process.exit(2);
  }
  restore(args.find((a) => !a.startsWith('--')), { force: args.includes('--force') })
    .then((r) => { console.log('Restore complete.\n' + JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error('Restore FAILED:', e.message); process.exit(1); });
}
