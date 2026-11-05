'use strict';
/**
 * تقديم ملفات الوسائط بأمان: GET /media/:file و GET /media/audio/:lang/:file
 * - اسم الملف بقائمة أحرف مسموحة فقط، بدون مسارات أو ".."
 * - أنواع MIME محددة حسب الامتداد (لا يُخمّن من المحتوى) + nosniff
 * - المسار النهائي (بعد realpath) يجب أن يبقى داخل مجلد uploads
 * - دعم Range للفيديو (206 / 416) وHEAD وETag
 */
const fs = require('fs');
const path = require('path');

const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4' };
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LANGS = new Set(['ar', 'en']);

function defaultUploadsDir() {
  return process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, '..', '..', 'uploads');
}

function notFound(res) {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'الملف غير موجود' } });
}

/** يعيد {start,end} أو null (غير صالح) أو undefined (لا يوجد Range). */
function parseRange(header, size) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { // آخر n بايت
    const n = Number(m[2]);
    if (!n) return null;
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return null;
  return { start, end };
}

/** يحل المسار الآمن أو يعيد null. */
function resolveSafe(baseDir, parts, mimeMap, nameForExt) {
  const name = parts[parts.length - 1];
  if (!NAME_RE.test(name) || name.includes('..')) return null;
  const ext = path.extname(name).toLowerCase();
  if (!mimeMap[ext] || ext === name.toLowerCase()) return null;
  let realBase;
  try { realBase = fs.realpathSync(baseDir); } catch { return null; }
  const full = path.join(realBase, ...parts);
  let real;
  try { real = fs.realpathSync(full); } catch { return null; }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (!st.isFile()) return null;
  return { file: real, size: st.size, mtimeMs: st.mtimeMs, mime: mimeMap[ext] };
}

function send(req, res, info) {
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', info.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }

  const range = parseRange(req.headers.range, info.size);
  if (range === null) {
    res.status(416).setHeader('Content-Range', `bytes */${info.size}`);
    res.end();
    return;
  }
  let start = 0; let end = info.size - 1;
  if (range) { start = range.start; end = range.end; res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`); }
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  const stream = fs.createReadStream(info.file, { start, end });
  stream.on('error', () => { if (!res.headersSent) notFound(res); else res.destroy(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function createMediaHandlers(getUploadsDir = defaultUploadsDir) {
  return {
    file(req, res) {
      const info = resolveSafe(getUploadsDir(), [String(req.params.file)], MEDIA_MIME);
      if (!info) return notFound(res);
      return send(req, res, info);
    },
    audio(req, res) {
      const lang = String(req.params.lang);
      if (!LANGS.has(lang)) return notFound(res);
      const info = resolveSafe(path.join(getUploadsDir(), 'audio', lang), [String(req.params.file)], AUDIO_MIME);
      if (!info) return notFound(res);
      return send(req, res, info);
    },
  };
}

module.exports = { createMediaHandlers, parseRange, resolveSafe, MEDIA_MIME, AUDIO_MIME, NAME_RE, defaultUploadsDir };
