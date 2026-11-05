'use strict';
/**
 * adsUpload — رفع آمن لملفات الإعلانات (حساب 5).
 *
 * الأمان:
 *  - النوع يُحدد بفحص الـ magic bytes (أول 16 بايت) وليس بالامتداد أو Content-Type.
 *  - المسموح: JPG / PNG / WebP / MP4 فقط (لا SVG، لا GIF، لا HTML).
 *  - حد حجم لكل نوع (صور/فيديو) + حد أعلى عام في multer.
 *  - اسم الملف المخزن عشوائي (16 بايت hex) + امتداد من النوع المكتشف؛ اسم العميل يُهمل تماماً.
 *  - الملف يُكتب أولاً في مجلد مؤقت ثم يُنقل (rename) بعد اجتياز الفحص.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const MB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ imageBytes: 5 * MB, videoBytes: 50 * MB });
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'M4V ', 'MSNV']);
const ALLOWED_DECLARED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
const STORED_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|webp|mp4)$/;

class AdsError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AdsError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

function limitsFromEnv(env = process.env) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n * MB) : d;
  };
  return {
    imageBytes: num(env.ADS_MAX_IMAGE_MB, DEFAULT_LIMITS.imageBytes),
    videoBytes: num(env.ADS_MAX_VIDEO_MB, DEFAULT_LIMITS.videoBytes),
  };
}

/** يكتشف نوع الملف من المحتوى. يرجع null إن لم يكن ضمن المسموح. */
function detectMedia(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'image', ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', ext: '.png', mime: 'image/png' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { kind: 'image', ext: '.webp', mime: 'image/webp' };
  }
  if (buf.toString('latin1', 4, 8) === 'ftyp' && MP4_BRANDS.has(buf.toString('latin1', 8, 12))) {
    return { kind: 'video', ext: '.mp4', mime: 'video/mp4' };
  }
  return null;
}

function readHead(filePath, n = 16) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch (_) { /* غير موجود أو مشغول: يتجاهل */ }
}

function isValidStoredName(name) {
  return typeof name === 'string' && STORED_NAME_RE.test(name);
}

/**
 * @param {{uploadsDir:string, limits?:{imageBytes:number, videoBytes:number}}} opts
 * @returns {{ middleware: Function, commit: Function, discard: Function, tmpDir: string }}
 */
function createAdsUpload({ uploadsDir, limits = limitsFromEnv() }) {
  if (!uploadsDir) throw new Error('uploadsDir is required');
  const tmpDir = path.join(uploadsDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpDir),
    filename: (_req, _file, cb) => cb(null, `up-${crypto.randomBytes(16).toString('hex')}`),
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: Math.max(limits.imageBytes, limits.videoBytes),
      files: 1,
      fields: 20,
      fieldSize: 16 * 1024,
      parts: 30,
    },
    fileFilter: (_req, file, cb) => {
      // فحص مبكر فقط؛ الحكم النهائي للمحتوى في commit()
      if (!ALLOWED_DECLARED_MIME.has(file.mimetype)) {
        return cb(new AdsError(400, 'VALIDATION', 'نوع الملف غير مسموح (JPG, PNG, WebP, MP4 فقط)'));
      }
      return cb(null, true);
    },
  }).single('file');

  function middleware(req, res, next) {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof AdsError) return next(err);
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من الحد المسموح' : 'طلب رفع غير صالح';
        return next(new AdsError(400, 'VALIDATION', msg, { upload: err.code }));
      }
      return next(err);
    });
  }

  /**
   * يفحص الملف المؤقت ويحوله لاسم عشوائي نهائي. يرمي AdsError ويحذف المؤقت عند الفشل.
   * @returns {{ storedName, kind, mime, size, finalPath }}
   */
  function commit(file) {
    if (!file) return null;
    try {
      const head = readHead(file.path, 16);
      const info = detectMedia(head);
      if (!info) throw new AdsError(400, 'VALIDATION', 'محتوى الملف ليس صورة JPG/PNG/WebP أو فيديو MP4 صالحاً');
      const size = fs.statSync(file.path).size;
      const max = info.kind === 'image' ? limits.imageBytes : limits.videoBytes;
      if (size > max) {
        throw new AdsError(400, 'VALIDATION', `حجم ${info.kind === 'image' ? 'الصورة' : 'الفيديو'} أكبر من الحد (${Math.floor(max / MB)}MB)`);
      }
      const storedName = `${crypto.randomBytes(16).toString('hex')}${info.ext}`;
      const finalPath = path.join(uploadsDir, storedName);
      fs.renameSync(file.path, finalPath);
      return { storedName, kind: info.kind, mime: info.mime, size, finalPath };
    } catch (e) {
      safeUnlink(file.path);
      throw e;
    }
  }

  function discard(file) {
    if (file && file.path) safeUnlink(file.path);
  }

  return { middleware, commit, discard, tmpDir };
}

module.exports = {
  AdsError,
  createAdsUpload,
  detectMedia,
  limitsFromEnv,
  isValidStoredName,
  safeUnlink,
  DEFAULT_LIMITS,
};
