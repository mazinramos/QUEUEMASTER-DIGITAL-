'use strict';
/**
 * يبني تطبيق Express صغيراً يركّب راوتر الإعلانات الحقيقي مع:
 *  - DB مؤقتة حقيقية (SQLite) من عقد database.md
 *  - مصادقة مزيفة عبر هيدر x-test-staff (JSON {id, clinicId, role}) تحاكي حارس حساب 1
 *  - بث مسجّل (يُلتقط بدل Socket.IO)
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTestDb } = require('./testDb');
const { createAdsService } = require('../../src/services/adsService');
const { createAdsUpload } = require('../../src/services/adsUpload');
const { createAdsRouter } = require('../../src/routes/ads');

const RANK = { staff: 1, manager: 2, admin: 3 };

function fakeGuards(minRole = 'manager') {
  return (req, res, next) => {
    const raw = req.headers['x-test-staff'];
    if (!raw) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'no session' } });
    const staff = JSON.parse(raw);
    if ((RANK[staff.role] || 0) < RANK[minRole]) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'role' } });
    req.staff = staff;
    return next();
  };
}

async function startAdsHarness({ limits, clock } = {}) {
  const t = createTestDb();
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-uploads-'));
  const events = [];
  let nowValue = clock || new Date();
  const service = createAdsService({
    getDb: () => t.db,
    emit: (clinicId, event, payload) => events.push({ clinicId, event, payload }),
    uploadsDir,
    now: () => new Date(nowValue),
    logger: { error() {}, warn() {} },
  });
  const upload = createAdsUpload({ uploadsDir, limits });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', createAdsRouter({ service, upload, guards: fakeGuards() }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const asStaff = (staff) => ({ 'x-test-staff': JSON.stringify(staff) });
  const admin1 = asStaff({ id: 1, clinicId: 1, role: 'admin' });
  const admin2 = asStaff({ id: 2, clinicId: 2, role: 'admin' });

  async function call(method, url, { headers = admin1, json, form } = {}) {
    const init = { method, headers: { ...headers } };
    if (json !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(json); }
    if (form) init.body = form;
    const res = await fetch(base + url, init);
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
  }

  function makeForm(fields = {}, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    if (file) fd.append('file', new Blob([file.buffer], { type: file.type }), file.name);
    return fd;
  }

  return {
    base, service, db: t.db, uploadsDir, events, call, makeForm, admin1, admin2, asStaff,
    setNow(d) { nowValue = d; },
    uploadedFiles: () => fs.readdirSync(uploadsDir).filter((f) => !f.startsWith('.')),
    tmpFiles: () => fs.readdirSync(path.join(uploadsDir, '.tmp')),
    async close() {
      service.stopScheduler();
      await new Promise((r) => server.close(r));
      t.cleanup();
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startAdsHarness };
