'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./queueTestHelpers');
const q = require('./queueDb');

test('إعادة تشغيل السيرفر (عملية جديدة): التذاكر باقية والتوكن يعمل والترقيم يكمل', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-restart-'));
  const file = path.join(dir, 'q.db');
  const env = Object.assign({}, process.env, { TOKEN_PEPPER: 'test-pepper-0123456789abcdef', QM_SILENT: '1' });
  const child = path.join(__dirname, 'queueRestart.child.js');
  { const { db } = H.setup(file); db.close(); }
  const first = JSON.parse(execFileSync(process.execPath, [child, file, 'issue'], { env }).toString());
  const second = JSON.parse(execFileSync(process.execPath, [child, file, 'read', first.tokens[1]], { env }).toString());
  assert.equal(second.status, 'waiting');
  assert.equal(second.number, 'A-002');
  assert.equal(second.ahead, 1);
  assert.equal(second.nextNumber, 'A-003');
  // pepper مختلف بعد "إعادة التشغيل" = التوكن القديم يصبح غير صالح (تأكيد أن الـ pepper ثابت يجب أن يبقى في .env)
  const env2 = Object.assign({}, env, { TOKEN_PEPPER: 'another-pepper-0123456789ab' });
  assert.throws(() => execFileSync(process.execPath, [child, file, 'read', first.tokens[1]], { env: env2, stdio: 'pipe' }));
  fs.rmSync(dir, { recursive: true, force: true });
});
