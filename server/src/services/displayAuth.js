'use strict';
/**
 * جسر مصادقة الشاشات لـ Socket.IO (ملف مشرف: يربط حساب 2 بحساب 4).
 * sockets/index.js يتوقع: resolveDisplay(cookieValue) -> { displayId, clinicId } | null
 * وحساب 4 يوفّر: displayService.authenticateDisplay(db, cookieHeader).
 * بدون هذا الملف كانت كل اتصالات الشاشة ترفض بـ UNAUTHENTICATED.
 */
const displayService = require('./displayService');
const { getDb } = require('./queueDb');

function resolveDisplay(cookieValue) {
  if (!cookieValue) return null;
  const row = displayService.authenticateDisplay(getDb(), `${displayService.COOKIE_NAME}=${cookieValue}`);
  return row ? { displayId: row.id, clinicId: row.clinic_id } : null;
}

module.exports = { resolveDisplay };
