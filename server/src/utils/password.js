'use strict';
// كلمات المرور: Argon2id إن توفرت الحزمة الأصلية، وإلا scrypt المدمج في Node (مثلاً فشل بناء argon2 على Windows).
// اسم الخوارزمية داخل الـ hash نفسه، والتحقق يدعم الاثنين، ويُعاد التشفير عند الدخول إذا اختلفت الخوارزمية/المعاملات.
const crypto = require('crypto');

let argon2 = null;
try { argon2 = require('argon2'); } catch (e) { argon2 = null; } // optionalDependency
let forceScrypt = process.env.FORCE_SCRYPT === '1';

const ARGON_OPTS = argon2 ? { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } : null;
// scrypt: N=2^15, r=8, p=1 (~32MB) مستوى OWASP الموصى به عند عدم توفر Argon2
const SCRYPT = { ln: 15, r: 8, p: 1, keyLen: 64, saltLen: 16 };
const scryptMaxmem = (ln, r) => 128 * (2 ** ln) * r * 2 + 1024 * 1024;

const argonAvailable = () => !!argon2 && !forceScrypt;
const preferred = () => (argonAvailable() ? 'argon2id' : 'scrypt');
function _forceScrypt(on) { forceScrypt = !!on; } // اختبارات

const scryptAsync = (plain, salt, keyLen, ln, r, p) => new Promise((resolve, reject) => {
  crypto.scrypt(plain, salt, keyLen, { N: 2 ** ln, r, p, maxmem: scryptMaxmem(ln, r) }, (err, key) => (err ? reject(err) : resolve(key)));
});

function algorithm(hash) {
  if (typeof hash !== 'string') return null;
  if (hash.startsWith('$argon2id$')) return 'argon2id';
  if (hash.startsWith('$scrypt$')) return 'scrypt';
  return null;
}

async function hashPassword(plain) {
  if (argonAvailable()) return argon2.hash(plain, ARGON_OPTS);
  const salt = crypto.randomBytes(SCRYPT.saltLen);
  const key = await scryptAsync(plain, salt, SCRYPT.keyLen, SCRYPT.ln, SCRYPT.r, SCRYPT.p);
  return `$scrypt$ln=${SCRYPT.ln},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseScrypt(hash) {
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(hash);
  if (!m) return null;
  const ln = +m[1]; const r = +m[2]; const p = +m[3];
  if (ln < 10 || ln > 20 || r < 1 || r > 16 || p < 1 || p > 16) return null; // لا نسمح بمعاملات تستنزف الذاكرة
  return { ln, r, p, salt: Buffer.from(m[4], 'base64'), key: Buffer.from(m[5], 'base64') };
}

async function verifyPassword(hash, plain) {
  try {
    const alg = algorithm(hash);
    if (alg === 'argon2id') {
      if (!argon2) return false; // hash أنشئ على جهاز فيه argon2 ولا يمكن التحقق هنا
      return await argon2.verify(hash, plain);
    }
    if (alg === 'scrypt') {
      const h = parseScrypt(hash);
      if (!h || !h.key.length) return false;
      const got = await scryptAsync(plain, h.salt, h.key.length, h.ln, h.r, h.p);
      return got.length === h.key.length && crypto.timingSafeEqual(got, h.key);
    }
    return false;
  } catch { return false; }
}

// true => أعد التشفير بعد نجاح الدخول
function needsRehash(hash) {
  const alg = algorithm(hash);
  if (!alg) return false;
  if (alg !== preferred()) return alg === 'scrypt' ? argonAvailable() : false; // لا ننزل من argon2 إلى scrypt تلقائياً
  if (alg === 'scrypt') { const h = parseScrypt(hash); return !h || h.ln < SCRYPT.ln || h.r < SCRYPT.r; }
  try { return argon2.needsRehash(hash, ARGON_OPTS); } catch { return false; }
}

function randomPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(len)) out += chars[b % chars.length];
  return out;
}
module.exports = { hashPassword, verifyPassword, needsRehash, algorithm, randomPassword, preferred, _forceScrypt, argonAvailable };
