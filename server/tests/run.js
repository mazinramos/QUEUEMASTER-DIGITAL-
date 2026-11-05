'use strict';
// مشغّل اختبارات متوافق مع Windows/Linux (لا glob ولا bash). الاستخدام: node run.js [فلتر-اسم]
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'helpers') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const filter = process.argv[2];
const files = walk(__dirname).filter((f) => !filter || f.includes(filter)).sort();
if (files.length === 0) { console.error('لا توجد ملفات اختبار'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
process.exit(r.status === null ? 1 : r.status);
