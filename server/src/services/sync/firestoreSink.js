'use strict';
// كتابة إلى Firestore بمعاملة: تتجاهل أي إصدار أقدم/مساوٍ للمخزن (idempotent + مقاوم لإعادة الترتيب).
// يستقبل instance من admin.firestore() (قابل للحقن/المحاكاة في الاختبار).
function createFirestoreSink(firestore) {
  return {
    name: 'firestore',
    async apply({ path, operation, data, version }) {
      const ref = firestore.doc(path);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const remote = snap.exists ? snap.get('_version') : null;
        if (typeof remote === 'number' && remote >= version) return 'stale';
        if (operation === 'delete') tx.set(ref, { _deleted: true, _version: version, _syncedAt: new Date().toISOString() });
        else tx.set(ref, Object.assign({}, data, { _deleted: false, _version: version, _syncedAt: new Date().toISOString() }));
        return 'written';
      });
    },
  };
}
module.exports = { createFirestoreSink };
