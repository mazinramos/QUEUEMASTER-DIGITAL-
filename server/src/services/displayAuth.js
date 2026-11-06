'use strict';
/**
 * عقد حساب 2 (sockets/index.js): resolveDisplay(cookieValue) -> { displayId, clinicId } | null
 * cookieValue = قيمة كوكي qm.display (بدون الاسم). يتحقق من التوقيع، وأن الشاشة والعيادة فعّالتان،
 * وأن كود الإقران لم يُعاد ضبطه. يُستدعى عند كل اتصال Socket.IO.
 */
const svc = require('./displayService');

function getDb() {
  const m = require('../database');
  return (typeof m.getDb === 'function' && m.getDb()) || m.db || m;
}

function resolveDisplay(cookieValue, db) {
  if (!cookieValue || typeof cookieValue !== 'string' || cookieValue.length > 200) return null;
  let row;
  try { row = svc.authenticateDisplay(db || getDb(), `${svc.COOKIE_NAME}=${encodeURIComponent(cookieValue)}`); } catch (e) { return null; }
  return row ? { displayId: row.id, clinicId: row.clinic_id } : null;
}

module.exports = { resolveDisplay };
