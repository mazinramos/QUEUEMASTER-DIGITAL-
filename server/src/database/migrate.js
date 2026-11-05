'use strict';
const fs = require('fs');
const path = require('path');
const { getDb, nowIso, close } = require('./index');

const DIR = path.join(__dirname, 'migrations');

function runMigrations(db = getDb()) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const ran = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, nowIso());
    })();
    ran.push(f);
  }
  return ran;
}

module.exports = { runMigrations };

if (require.main === module) {
  const ran = runMigrations();
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  close();
}
