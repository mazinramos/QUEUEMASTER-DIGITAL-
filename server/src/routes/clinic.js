'use strict';
const express = require('express');
const { z } = require('zod');
const { getDb, nowIso } = require('../database');
const { ok } = require('../utils/respond');
const { E } = require('../utils/errors');
const { requireRole, clinicScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeAudit } = require('../middleware/audit');
const { clinic: ser } = require('../utils/rows');

const router = express.Router();
router.use(requireRole('manager'), clinicScope);

const tzOk = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const nullableStr = (n) => z.string().trim().max(n).nullable().optional();
const schema = z.object({
  nameAr: z.string().trim().min(2).max(120).optional(),
  nameEn: nullableStr(120),
  address: nullableStr(300),
  phone: nullableStr(40),
  email: z.string().trim().email().max(120).nullable().optional(),
  timezone: z.string().refine(tzOk, 'invalid timezone').optional(),
  defaultLanguage: z.enum(['ar', 'en']).optional(),
}).strict();

router.get('/', (req, res) => {
  const row = getDb().prepare('SELECT * FROM clinics WHERE id = ?').get(req.clinicId);
  const settings = Object.fromEntries(getDb().prepare('SELECT key, value FROM clinic_settings WHERE clinic_id = ?')
    .all(req.clinicId).map((r) => [r.key, r.value]));
  ok(res, { ...ser(row), settings });
});

router.put('/', requireRole('admin'), validate(schema), (req, res) => {
  const map = { nameAr: 'name_ar', nameEn: 'name_en', address: 'address', phone: 'phone', email: 'email',
    timezone: 'timezone', defaultLanguage: 'default_language' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (req.body[k] !== undefined) { sets.push(`${col} = ?`); vals.push(req.body[k]); }
  if (!sets.length) throw E.validation('Nothing to update');
  getDb().prepare(`UPDATE clinics SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), req.clinicId);
  writeAudit(req, 'clinic.update', 'clinic', req.clinicId, req.body);
  ok(res, ser(getDb().prepare('SELECT * FROM clinics WHERE id = ?').get(req.clinicId)));
});

module.exports = { path: '/api/admin/clinic', router };
