'use strict';
/**
 * reportsCsv — توليد CSV آمن (حساب 5).
 *  - UTF-8 مع BOM ليفتح العربي سليماً في Excel
 *  - CRLF، وتغليف الحقول التي تحوي , " أو سطر جديد
 *  - حماية من CSV/Formula injection: أي نص يبدأ بـ = + - @ أو tab/CR يُسبق بـ ' (أسماء الخدمات/الموظفين قد تكون خبيثة)
 */
const BOM = '\uFEFF';
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  let s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** @param {string[]} headers  @param {Array<Array<any>>} rows */
function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, cell, BOM };
