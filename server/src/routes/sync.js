'use strict';
// GET /api/admin/sync/status — حالة المزامنة الصادقة (لا يدّعي أنها تعمل بدون credentials)
const express = require('express');
const sync = require('../services/sync/syncWorker');
const q = require('../services/queueDb');
const { requireStaff } = require('../services/queueAuth');
const { sendError } = require('../services/queueErrors');

const router = express.Router();
router.get('/status', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, requireStaff('manager'), (req, res) => {
  try {
    const row = q.getDb().prepare('SELECT clinic_id FROM staff WHERE id=?').get(req.qmStaffId);
    res.json({ ok: true, data: sync.status(row.clinic_id) });
  } catch (e) { sendError(res, e); }
});

module.exports = { path: '/api/admin/sync', router };
