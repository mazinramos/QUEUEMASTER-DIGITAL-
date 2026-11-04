'use strict';
const argon2 = require('argon2');
const crypto = require('crypto');

const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const hashPassword = (plain) => argon2.hash(plain, OPTS);
async function verifyPassword(hash, plain) {
  try { return await argon2.verify(hash, plain); } catch { return false; }
}
function randomPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(len)) out += chars[b % chars.length];
  return out;
}
module.exports = { hashPassword, verifyPassword, randomPassword };
