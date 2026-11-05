'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const H = require('./queueTestHelpers');
const q = require('./queueDb');

const run = (workerData) => new Promise((resolve, reject) => {
  const w = new Worker(path.join(__dirname, 'queueConcurrency.worker.js'), { workerData });
  w.once('message', resolve); w.once('error', reject);
});

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-conc-'));
  return { dir, file: path.join(dir, 'q.db') };
}

test('إصدار متوازي: 8 threads × 24 تذكرة على خدمتين = أرقام فريدة ومتسلسلة بلا فجوات', async () => {
  const { dir, file } = tmpDb();
  const { db, ids } = H.setup(file);
  q.setDb(db);
  const res = await Promise.all(Array.from({ length: 8 }, () =>
    run({ file, mode: 'issue', rounds: 24, clinicId: ids.clinicId, serviceIds: [ids.A, ids.B] })));
  assert.deepEqual(res.flatMap((r) => r.errors), []);
  const all = res.flatMap((r) => r.issued);
  assert.equal(all.length, 192);
  assert.equal(new Set(all).size, 192, 'duplicate ticket numbers');
  for (const prefix of ['A', 'B']) {
    const nums = all.filter((n) => n.startsWith(prefix + '-')).map((n) => Number(n.slice(2))).sort((a, b) => a - b);
    assert.equal(nums.length, 96);
    assert.deepEqual(nums, Array.from({ length: 96 }, (_, i) => i + 1), `gap in ${prefix}`);
  }
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('20 call-next متوازٍ من 5 موظفين على خدمتين: لا تذكرة تُنادى مرتين، والأرقام فريدة ومتسلسلة', async () => {
  const { dir, file } = tmpDb();
  const { db, ids } = H.setup(file);
  q.setDb(db);
  q.setClock(null);
  // 40 تذكرة (20 لكل خدمة) تُصدَر بالتوازي أيضاً
  await Promise.all(Array.from({ length: 4 }, () => run({ file, mode: 'issue', rounds: 10, clinicId: ids.clinicId, serviceIds: [ids.A, ids.B] })));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 40);

  // 5 موظفين، كل واحد 4 نداءات (=20) بالتوازي، يجمعون من الخدمتين
  const res = await Promise.all(ids.staff.map((s, i) => run({ file, mode: 'call', staffId: s, counterId: ids.counters[i], rounds: 4 })));
  assert.deepEqual(res.flatMap((r) => r.errors), []);
  const called = res.flatMap((r) => r.called);
  assert.equal(called.length, 20);
  assert.equal(new Set(called).size, 20, 'a ticket was called twice');

  // تحقق من DB: كل تذكرة نُوديت مرة واحدة فقط (حدث called واحد لكل تذكرة)
  const dup = db.prepare(`SELECT ticket_id, COUNT(*) c FROM ticket_events WHERE type='called' GROUP BY ticket_id HAVING c>1`).all();
  assert.deepEqual(dup, []);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='completed'`).get().c, 20);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='waiting'`).get().c, 20);

  // الترقيم: كل خدمة متسلسلة 1..20 بلا تكرار
  for (const prefix of ['A', 'B']) {
    const nums = db.prepare(`SELECT seq_number s FROM tickets WHERE display_number LIKE ? ORDER BY s`).all(prefix + '-%').map((r) => r.s);
    assert.equal(new Set(nums).size, nums.length);
    assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1));
  }
  // الاحترام لأقدمية الطابور: ما نُودي أقدم مما بقي (ضمن كل خدمة)
  for (const svc of [ids.A, ids.B]) {
    const maxCalled = db.prepare(`SELECT MAX(seq_number) m FROM tickets WHERE service_id=? AND status='completed'`).get(svc).m || 0;
    const minWaiting = db.prepare(`SELECT MIN(seq_number) m FROM tickets WHERE service_id=? AND status='waiting'`).get(svc).m || Infinity;
    if (maxCalled && minWaiting !== Infinity) assert.ok(maxCalled <= minWaiting + 5, 'queue order grossly violated');
  }
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
