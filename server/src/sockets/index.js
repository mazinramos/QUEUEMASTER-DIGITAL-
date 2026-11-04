'use strict';
// TEMPORARY STUB (account 1). Account 2 owns this file and will replace it.
// Contract: init(httpServer), emitToClinic(clinicId, event, payload), emitToRoom(room, event, payload)
let io = null;
function init(httpServer) {
  try {
    const { Server } = require('socket.io');
    io = new Server(httpServer, { path: '/socket.io' });
  } catch (e) { io = null; }
  return io;
}
function emitToClinic() {}
function emitToRoom() {}
module.exports = { init, emitToClinic, emitToRoom };
