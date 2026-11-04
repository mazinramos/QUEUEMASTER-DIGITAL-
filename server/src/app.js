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

  app.get('/api/health', (req, res) =>
    ok(res, { status: 'ok', time: new Date().toISOString(), version: config.version })
  );

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
  return app;
}

module.exports = { createApp };
