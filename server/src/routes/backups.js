'use strict';
const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { E } = require('../utils/errors');
const { requireRole } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { strictLimiter } = require('../middleware/rateLimit');
const backup = require('../services/backup');

const router = express.Router();
// النسخة تحوي بيانات كل العيادات (قاعدة واحدة) => مدير النظام فقط
router.use(requireRole('admin'));

router.get('/', (req, res) => ok(res, { items: backup.listBackups(), keep: parseInt(process.env.BACKUP_KEEP || '7', 10) || 7 }));

router.post('/', strictLimiter, wrap(async (req, res) => {
  const r = await backup.createBackup({ reason: 'manual' });
  writeAudit(req, 'backup.create', 'backup', r.name, { sizeBytes: r.sizeBytes, removed: r.removed });
  ok(res, r, 201);
}));

router.get('/:name', (req, res, next) => {
  const file = backup.resolveBackupPath(req.params.name);
  if (!file) return next(E.notFound('Backup not found'));
  writeAudit(req, 'backup.download', 'backup', req.params.name);
  return res.download(file, req.params.name, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(err); });
});

module.exports = { path: '/api/admin/backups', router };
