'use strict';
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const backup = require('./services/backup');
const sockets = require('./sockets');

const app = createApp();
const httpServer = http.createServer(app);
sockets.init(httpServer);

httpServer.listen(config.port, () => {
  const port = httpServer.address().port;
  logger.info('listening', { url: config.baseUrl, port, env: config.env, cookieSecure: config.session.secureCookie, pid: process.pid });
  if (config.session.secureCookie === 'true' && /^http:/i.test(config.baseUrl)) {
    logger.warn('COOKIE_SECURE=true but BASE_URL is http: browsers will drop the session cookie. Use COOKIE_SECURE=false or auto.');
  }
  logger.info('routes', { loaded: app.get('loadedRoutes') });
  if (backup.startScheduler({ log: { log: (m) => logger.info(m), error: (...a) => logger.error(a.join(' ')) } })) {
    logger.info('backup scheduler started', { everyHours: Number(process.env.BACKUP_INTERVAL_HOURS) || 24, keep: Number(process.env.BACKUP_KEEP) || 7 });
  }
});

let closing = false;
// إيقاف نظيف: لا طلبات جديدة -> المؤقتات والـ workers -> Socket.IO -> إغلاق الاتصالات -> قاعدة البيانات
async function shutdown(signal, exitCode = 0) {
  if (closing) return;
  closing = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => { logger.error('forced exit after timeout'); process.exit(1); }, 10000);
  force.unref();
  try {
    backup.stopScheduler();
    if (app.locals.stopTimers) app.locals.stopTimers();
    const closed = new Promise((resolve) => httpServer.close(resolve));
    if (typeof sockets.close === 'function') await sockets.close(); // يوقف workers ويغلق Socket.IO
    httpServer.closeIdleConnections && httpServer.closeIdleConnections();
    setTimeout(() => httpServer.closeAllConnections && httpServer.closeAllConnections(), 2000).unref();
    await closed;
  } catch (e) {
    logger.error('error during shutdown', { message: e.message });
    exitCode = exitCode || 1;
  } finally {
    try { require('./database').close(); } catch (e) { logger.error('db close failed', { message: e.message }); exitCode = exitCode || 1; }
    logger.info('bye', { exitCode });
    process.exit(exitCode);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig)); // SIGBREAK: Ctrl+Break على Windows
process.on('uncaughtException', (e) => { logger.error('uncaught exception', { message: e.message, stack: e.stack }); shutdown('uncaughtException', 1); });
process.on('unhandledRejection', (e) => { logger.error('unhandled rejection', { message: e && e.message, stack: e && e.stack }); });
