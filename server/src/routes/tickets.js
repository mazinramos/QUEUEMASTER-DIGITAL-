'use strict';
// استعلامات/إجراءات الأدمن على التذاكر — api-contract.md  [ح2]  (دور manager فأعلى)
const express = require('express');
const Q = require('../services/queueService');
const { requireStaff } = require('../services/queueAuth');
const { QueueError, sendError } = require('../services/queueErrors');

const router = express.Router();
router.use(express.json({ limit: '10kb' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { sendError(res, e); } };
const ok = (res, data) => res.json({ ok: true, data });
const guard = requireStaff('manager');

router.get('/tickets', guard, wrap((req, res) => {
  const { date, serviceId, status, q, page } = req.query;
  ok(res, Q.listTickets({ staffId: req.qmStaffId, date, serviceId, status, q, page }));
}));
router.get('/tickets/:publicId/events', guard, wrap((req, res) => {
  ok(res, { events: Q.ticketEvents({ staffId: req.qmStaffId, publicId: req.params.publicId }) });
}));
router.post('/tickets/:publicId/cancel', guard, wrap((req, res) => {
  ok(res, { ticket: Q.adminCancel({ staffId: req.qmStaffId, publicId: req.params.publicId, reason: (req.body || {}).reason }) });
}));
router.post('/queue/reset-day', guard, wrap((req, res) => {
  ok(res, Q.resetDay({ staffId: req.qmStaffId, confirm: (req.body || {}).confirm }));
}));

module.exports = { path: '/api/admin', router };
