'use strict';
// The ONLY entry point to the database. Everyone else: require('../database') -> getDb()
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;

function open(dbPath = config.dbPath) {
  if (db) return db;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function getDb() {
  return db || open();
}

function close() {
  if (db) { db.close(); db = null; }
}

const nowIso = () => new Date().toISOString();

module.exports = { open, getDb, close, nowIso };
