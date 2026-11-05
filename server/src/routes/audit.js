'use strict';
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../database');
const { ok } = require('../utils/respond');
const { requireRole, clinicScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();
router.use(requireRole('admin'), clinicScope);

const q = z.object({
  action: z.string().max(60).optional(),
  entity: z.string().max(40).optional(),
  staffId: z.coerce.number().int().positive().optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', validate(q, 'query'), (req, res) => {
  const { action, entity, staffId, from, to, page, pageSize } = req.query;
  const where = ['a.clinic_id = ?']; const args = [req.clinicId];
  if (action) { where.push('a.action LIKE ?'); args.push(`${action.replace(/[%_]/g, '')}%`); }
  if (entity) { where.push('a.entity = ?'); args.push(entity); }
  if (staffId) { where.push('a.staff_id = ?'); args.push(staffId); }
  if (from) { where.push('a.created_at >= ?'); args.push(from); }
  if (to) { where.push('a.created_at <= ?'); args.push(to); }
  const w = where.join(' AND ');
  const total = getDb().prepare(`SELECT COUNT(*) c FROM audit_logs a WHERE ${w}`).get(...args).c;
  const items = getDb().prepare(
    `SELECT a.id, a.action, a.entity, a.entity_id AS entityId, a.details, a.ip, a.created_at AS createdAt,
            a.staff_id AS staffId, s.username
       FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
      WHERE ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, (page - 1) * pageSize).map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  ok(res, { items, page, pageSize, total });
});

module.exports = { path: '/api/admin/audit', router };
