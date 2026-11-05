'use strict';
// ناقل أحداث داخلي: الخدمات تنشر هنا **بعد commit** فقط، و sockets/index.js يشترك ويبثّ.
// بهذا لا تلمس الخدمات Socket.IO مباشرة، ولا يحدث بث لمعاملة لم تُثبَّت.
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);

// msg = { clinicId, event, rooms:['staff','display','ticket'], ticketPublicId?, data }
function publish(msg) {
  try { bus.emit('msg', msg); } catch (e) {
    require('./queueLog').error('bus listener failed', { message: e.message });
  }
}
function subscribe(fn) { bus.on('msg', fn); return () => bus.off('msg', fn); }

module.exports = { publish, subscribe, _bus: bus };
