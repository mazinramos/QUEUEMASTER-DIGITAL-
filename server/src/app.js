'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { getDb } = require('./database');
const { runMigrations } = require('./database/migrate');
const { ok } = require('./utils/respond');
const { errorHandler, notFoundApi } = require('./middleware/errorHandler');
const { loadSession, purgeExpired } = require('./middleware/session');
const { csrfProtect } = require('./middleware/csrf');
const { apiLimiter } = require('./middleware/rateLimit');
const { requestLog } = require('./middleware/requestLog');

function loadRoutes(app) {
  const dir = path.join(__dirname, 'routes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const loaded = [];
  for (const f of files) {
    const mod = require(path.join(dir, f));
    if (!mod || !mod.path || !mod.router) {
      console.warn(`[routes] ${f} skipped: must export { path, router }`);
      continue;
    }
    app.use(mod.path, mod.router);
    loaded.push(`${mod.path} (${f})`);
  }
  return loaded;
}

function createApp({ autoMigrate = true } = {}) {
  const db = getDb();
  if (autoMigrate) runMigrations(db);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(requestLog);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.isProd ? undefined : false,
    })
  );
  app.use(express.json({ limit: '200kb' }));

  // API hardening: no caching, global rate limit, session + CSRF
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', apiLimiter, loadSession, csrfProtect);

  // لا أسرار هنا: حالة، قاعدة البيانات، مدة التشغيل، الإصدار
  app.get('/api/health', (req, res) => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const data = { status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'ok' : 'error', uptime: Math.round(process.uptime()),
      time: new Date().toISOString(), version: config.version };
    return res.status(dbOk ? 200 : 503).json(dbOk ? { ok: true, data }
      : { ok: false, error: { code: 'INTERNAL', message: 'database unavailable' }, data });
  });

  const loaded = loadRoutes(app);
  app.set('loadedRoutes', loaded);

  // static front-ends (owned by other accounts) + shared
  for (const name of ['patient', 'staff', 'admin', 'display']) {
    app.use(`/${name}`, express.static(path.join(config.webDir, name), { index: 'index.html' }));
  }
  app.use('/shared', express.static(path.join(config.webDir, 'shared')));
  app.get('/', (req, res) => res.redirect('/patient/'));

  app.use('/api', notFoundApi);
  app.use(errorHandler);
  purgeExpired();
  if (config.env !== 'test') {
    const t = setInterval(() => {
      try { purgeExpired(); require('./services/authService').purgeAttempts(); } catch { /* db closed */ }
    }, 10 * 60 * 1000);
    t.unref();
    app.locals.stopTimers = () => clearInterval(t);
  }
  return app;
}

module.exports = { createApp };
