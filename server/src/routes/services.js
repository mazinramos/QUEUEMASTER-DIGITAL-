'use strict';
const express = require('express');
const { z } = require('zod');
const { getDb, nowIso } = require('../database');
const { ok } = require('../utils/respond');
const { E } = require('../utils/errors');
const { requireRole, clinicScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeAudit } = require('../middleware/audit');
const { svc: ser } = require('../utils/rows');

const router = express.Router();
router.use(requireRole('manager'), clinicScope);

const base = {
  nameAr: z.string().trim().min(1).max(100),
  nameEn: z.string().trim().max(100).nullable().optional(),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,3}$/, 'prefix: 1-3 letters/digits'),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  estDurationMin: z.number().int().min(1).max(600).optional(),
  isActive: z.boolean().optional(),
};
const createSchema = z.object(base).strict();
const updateSchema = z.object(base).partial().strict();
const idSchema = z.object({ id: z.coerce.number().int().positive() });

const get = (req) => {
  const r = getDb().prepare('SELECT * FROM services WHERE id = ? AND clinic_id = ?').get(req.params.id, req.clinicId);
  if (!r) throw E.notFound('Service not found');
  return r;
};
const dupe = (e) => { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw E.conflict('Prefix already used in this clinic'); throw e; };

router.get('/', (req, res) => ok(res,
  getDb().prepare('SELECT * FROM services WHERE clinic_id = ? ORDER BY display_order, id').all(req.clinicId).map(ser)));
router.get('/:id', validate(idSchema, 'params'), (req, res) => ok(res, ser(get(req))));

router.post('/', requireRole('admin'), validate(createSchema), (req, res) => {
  const b = req.body; const now = nowIso();
  let id;
  try {
    id = getDb().prepare(`INSERT INTO services (clinic_id,name_ar,name_en,prefix,display_order,est_duration_min,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(req.clinicId, b.nameAr, b.nameEn ?? null, b.prefix, b.displayOrder ?? 0,
      b.estDurationMin ?? 10, b.isActive === false ? 0 : 1, now, now).lastInsertRowid;
  } catch (e) { dupe(e); }
  writeAudit(req, 'service.create', 'service', id, b);
  ok(res, ser(getDb().prepare('SELECT * FROM services WHERE id = ?').get(id)), 201);
});

router.put('/:id', requireRole('admin'), validate(idSchema, 'params'), validate(updateSchema), (req, res) => {
  get(req);
  const map = { nameAr: 'name_ar', nameEn: 'name_en', prefix: 'prefix', displayOrder: 'display_order',
    estDurationMin: 'est_duration_min', isActive: 'is_active' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (req.body[k] !== undefined) {
    sets.push(`${col} = ?`); vals.push(typeof req.body[k] === 'boolean' ? +req.body[k] : req.body[k]);
  }
  if (!sets.length) throw E.validation('Nothing to update');
  try { getDb().prepare(`UPDATE services SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND clinic_id = ?`)
    .run(...vals, nowIso(), req.params.id, req.clinicId); } catch (e) { dupe(e); }
  writeAudit(req, 'service.update', 'service', req.params.id, req.body);
  ok(res, ser(get(req)));
});

// soft delete (tickets reference services): deactivate; hard delete only when never used
router.delete('/:id', requireRole('admin'), validate(idSchema, 'params'), (req, res) => {
  get(req);
  const used = getDb().prepare('SELECT 1 FROM tickets WHERE service_id = ? LIMIT 1').get(req.params.id);
  if (used) {
    getDb().prepare('UPDATE services SET is_active = 0, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
    writeAudit(req, 'service.deactivate', 'service', req.params.id);
    return ok(res, { deleted: false, deactivated: true });
  }
  getDb().prepare('DELETE FROM services WHERE id = ? AND clinic_id = ?').run(req.params.id, req.clinicId);
  writeAudit(req, 'service.delete', 'service', req.params.id);
  return ok(res, { deleted: true });
});

module.exports = { path: '/api/admin/services', router };
