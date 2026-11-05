'use strict';
const http = require('http');
const config = require('./config');
const { createApp } = require('./app');

const app = createApp();
const httpServer = http.createServer(app);
require('./sockets').init(httpServer);

httpServer.listen(config.port, () => {
  console.log(`QueueMaster Digital listening on ${config.baseUrl} (port ${config.port}, ${config.env})`);
  console.log('Routes:', app.get('loadedRoutes').join(', ') || '(none)');
});

function shutdown() {
  httpServer.close(() => {
    require('./database').close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
