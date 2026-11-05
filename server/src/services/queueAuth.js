'use strict';
// جسر المصادقة: حساب 1 يملك الجلسات. هنا نقرأ هوية الموظف فقط، ثم نحمّل صلاحياته من الـ DB.
// المعرّف يُقرأ بالترتيب من: req.staff.id | req.user.id | req.session.staffId | req.session.staff.id | req.session.user.id
const q = require('./queueDb');
const { QueueError, sendError } = require('./queueErrors');

const RANK = { staff: 1, manager: 2, admin: 3 };

function staffIdFrom(req) {
  const s = req.session || {};
  return (req.staff && req.staff.id) || (req.user && req.user.id) || s.staffId || (s.staff && s.staff.id) || (s.user && s.user.id) || null;
}

function requireStaff(minRole = 'staff') {
  return (req, res, next) => {
    try {
      const id = staffIdFrom(req);
      if (!id) throw new QueueError('UNAUTHENTICATED', 'Login required');
      const row = q.getDb().prepare('SELECT id, clinic_id, role, is_active, must_change_password FROM staff WHERE id=?').get(id);
      if (!row || !row.is_active) throw new QueueError('UNAUTHENTICATED', 'Login required');
      if (row.must_change_password) {
        const e = new QueueError('FORBIDDEN', 'Password change required');
        e.code = 'PASSWORD_CHANGE_REQUIRED';
        throw e;
      }
      if (RANK[row.role] < RANK[minRole]) throw new QueueError('FORBIDDEN', 'Insufficient role');
      req.qmStaffId = row.id;
      next();
    } catch (e) { sendError(res, e); }
  };
}

module.exports = { requireStaff, staffIdFrom };
