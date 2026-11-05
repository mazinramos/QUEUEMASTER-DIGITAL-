'use strict';
const express = require('express');
const { z } = require('zod');
const { getDb, nowIso } = require('../database');
const { ok } = require('../utils/respond');
const { E } = require('../utils/errors');
const { requireRole, clinicScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeAudit } = require('../middleware/audit');

const router = express.Router();
router.use(requireRole('manager'), clinicScope);

const base = {
  nameAr: z.string().trim().min(1).max(100),
  nameEn: z.string().trim().max(100).nullable().optional(),
  number: z.number().int().min(1).max(999),
  isActive: z.boolean().optional(),
  serviceIds: z.array(z.number().int().positive()).max(100).optional(),
};
const createSchema = z.object(base).strict();
const updateSchema = z.object(base).partial().strict();
const idSchema = z.object({ id: z.coerce.number().int().positive() });

function ser(r) {
  const serviceIds = getDb().prepare('SELECT service_id FROM counter_services WHERE counter_id = ? ORDER BY service_id')
    .all(r.id).map((x) => x.service_id);
  return { id: r.id, nameAr: r.name_ar, nameEn: r.name_en, number: r.number, isActive: !!r.is_active, serviceIds, updatedAt: r.updated_at };
}
const get = (req) => {
  const r = getDb().prepare('SELECT * FROM counters WHERE id = ? AND clinic_id = ?').get(req.params.id, req.clinicId);
  if (!r) throw E.notFound('Counter not found');
  return r;
};
// every service id must belong to this clinic (isolation)
function setServices(counterId, clinicId, ids) {
  const uniq = [...new Set(ids)];
  if (uniq.length) {
    const found = getDb().prepare(`SELECT COUNT(*) c FROM services WHERE clinic_id = ? AND id IN (${uniq.map(() => '?').join(',')})`)
      .get(clinicId, ...uniq).c;
    if (found !== uniq.length) throw E.validation('Unknown serviceIds');
  }
  getDb().prepare('DELETE FROM counter_services WHERE counter_id = ?').run(counterId);
  const ins = getDb().prepare('INSERT INTO counter_services (counter_id, service_id) VALUES (?,?)');
  for (const s of uniq) ins.run(counterId, s);
}
const dupe = (e) => { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw E.conflict('Counter number already used'); throw e; };

router.get('/', (req, res) => ok(res,
  getDb().prepare('SELECT * FROM counters WHERE clinic_id = ? ORDER BY number').all(req.clinicId).map(ser)));
router.get('/:id', validate(idSchema, 'params'), (req, res) => ok(res, ser(get(req))));

router.post('/', requireRole('admin'), validate(createSchema), (req, res) => {
  const b = req.body; const now = nowIso();
  const id = getDb().transaction(() => {
    let cid;
    try {
      cid = getDb().prepare('INSERT INTO counters (clinic_id,name_ar,name_en,number,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.clinicId, b.nameAr, b.nameEn ?? null, b.number, b.isActive === false ? 0 : 1, now, now).lastInsertRowid;
    } catch (e) { dupe(e); }
    if (b.serviceIds) setServices(cid, req.clinicId, b.serviceIds);
    return cid;
  })();
  writeAudit(req, 'counter.create', 'counter', id, b);
  ok(res, ser(getDb().prepare('SELECT * FROM counters WHERE id = ?').get(id)), 201);
});

router.put('/:id', requireRole('admin'), validate(idSchema, 'params'), validate(updateSchema), (req, res) => {
  get(req);
  const b = req.body;
  getDb().transaction(() => {
    const map = { nameAr: 'name_ar', nameEn: 'name_en', number: 'number', isActive: 'is_active' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(typeof b[k] === 'boolean' ? +b[k] : b[k]); }
    try { getDb().prepare(`UPDATE counters SET ${sets.concat('updated_at = ?').join(', ')} WHERE id = ? AND clinic_id = ?`)
      .run(...vals, nowIso(), req.params.id, req.clinicId); } catch (e) { dupe(e); }
    if (b.serviceIds) setServices(Number(req.params.id), req.clinicId, b.serviceIds);
  })();
  writeAudit(req, 'counter.update', 'counter', req.params.id, b);
  ok(res, ser(get(req)));
});

router.delete('/:id', requireRole('admin'), validate(idSchema, 'params'), (req, res) => {
  get(req);
  const used = getDb().prepare('SELECT 1 FROM tickets WHERE counter_id = ? LIMIT 1').get(req.params.id);
  if (used) {
    getDb().prepare('UPDATE counters SET is_active = 0, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
    writeAudit(req, 'counter.deactivate', 'counter', req.params.id);
    return ok(res, { deleted: false, deactivated: true });
  }
  getDb().prepare('DELETE FROM counters WHERE id = ? AND clinic_id = ?').run(req.params.id, req.clinicId);
  writeAudit(req, 'counter.delete', 'counter', req.params.id);
  return ok(res, { deleted: true });
});

module.exports = { path: '/api/admin/counters', router };
