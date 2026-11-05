'use strict';
// مسارات الموظف — api-contract.md  [ح2]. الجلسة وCSRF من middleware حساب 1.
const express = require('express');
const Q = require('../services/queueService');
const { requireStaff } = require('../services/queueAuth');
const { QueueError, sendError } = require('../services/queueErrors');

const router = express.Router();
router.use(express.json({ limit: '10kb' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireStaff('staff'));

const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { sendError(res, e); } };
const ok = (res, data) => res.json({ ok: true, data });
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

router.get('/state', wrap((req, res) => {
  const counterId = intOrNull(req.query.counterId);
  if (Number.isNaN(counterId)) throw new QueueError('VALIDATION', 'Invalid counterId');
  ok(res, Q.getState({ staffId: req.qmStaffId, counterId }));
}));

router.post('/call-next', wrap((req, res) => {
  const b = req.body || {};
  const counterId = intOrNull(b.counterId); const serviceId = intOrNull(b.serviceId);
  if (Number.isNaN(counterId) || Number.isNaN(serviceId)) throw new QueueError('VALIDATION', 'Invalid counterId/serviceId');
  ok(res, { ticket: Q.callNext({ staffId: req.qmStaffId, counterId, serviceId }) });
}));

const actions = { recall: Q.recall, start: Q.start, complete: Q.complete, skip: Q.skip, return: Q.returnTicket, cancel: Q.cancel };
for (const [name, fn] of Object.entries(actions)) {
  router.post(`/tickets/:publicId/${name}`, wrap((req, res) => {
    const reason = name === 'cancel' && req.body ? req.body.reason : undefined;
    ok(res, { ticket: fn({ staffId: req.qmStaffId, publicId: req.params.publicId, reason }) });
  }));
}

router.post('/tickets/:publicId/transfer', wrap((req, res) => {
  const serviceId = intOrNull((req.body || {}).serviceId);
  if (serviceId == null || Number.isNaN(serviceId)) throw new QueueError('VALIDATION', 'serviceId is required');
  ok(res, { ticket: Q.transfer({ staffId: req.qmStaffId, publicId: req.params.publicId, serviceId }) });
}));

router.get('/lookup', wrap((req, res) => {
  ok(res, { ticket: Q.lookup({ staffId: req.qmStaffId, number: req.query.number }) });
}));

router.post('/verify', wrap((req, res) => {
  const token = (req.body || {}).token;
  ok(res, { ticket: Q.verify({ staffId: req.qmStaffId, token }) });
}));

module.exports = { path: '/api/queue', router };
