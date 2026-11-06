'use strict';
// يختبر الجسر الحقيقي (بدون محاكاة): كوكي شاشة يصدره displayService يجب أن يقبله resolveDisplay.
// اختبارات الـ sockets الأخرى تمرّر resolveDisplay مزيفاً فلم تكشف غيابه.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./queueTestHelpers');

test('displayAuth.resolveDisplay: كوكي شاشة صالح يُقبل وغير الصالح يُرفض', () => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
  const { db, ids } = H.setup(null);
  const svc = require('./displayService');
  const { resolveDisplay } = require('./displayAuth');
  const created = svc.createDisplay(db, { clinicId: ids.clinicId, name: 'اختبار' });
  const id = created.display?.id ?? created.id;
  const row = db.prepare('SELECT * FROM displays WHERE id=?').get(id);
  const good = svc.makeCookieValue(row);
  assert.deepEqual(resolveDisplay(good, db), { displayId: row.id, clinicId: ids.clinicId });
  assert.equal(resolveDisplay(good.slice(0, -2) + "00", db), null);
  assert.equal(resolveDisplay(''), null);
  assert.equal(resolveDisplay("abc", db), null);
  db.prepare('UPDATE displays SET is_active=0 WHERE id=?').run(id);
  assert.equal(resolveDisplay(good, db), null, 'شاشة معطّلة لا تُقبل');
});
