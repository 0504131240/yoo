// GET /api/backups/restore?date=YYYY-MM-DD&confirm=YES&adminPass=... —
// DESTRUCTIVE: fully overwrites the live app data with a past backup.
const { getDb, checkAdminPass } = require('../_lib/firebaseAdmin');
const { MAIN, NEW, partRef, findParts, partId, inBatches } = require('../_lib/appData');

module.exports = async (req, res) => {
  const { date, confirm } = req.query;
  if (!date || confirm !== 'YES') {
    res.status(400).send('Usage: ?date=YYYY-MM-DD&confirm=YES&adminPass=... — this OVERWRITES the live app data with that backup.');
    return;
  }
  const db = getDb();
  if (!(await checkAdminPass(db, req.query.adminPass))) {
    res.status(401).send('Unauthorized — pass ?adminPass=<the app admin password>');
    return;
  }
  const snap = await db.doc(`backups/${date}`).get();
  if (!snap.exists) {
    res.status(404).send('No backup found for ' + date);
    return;
  }
  const backedUpAt = snap.data().backedUpAt;
  const live = await findParts(db);
  const liveNew = live && live.loc === NEW ? live.docs : [];
  if (snap.data().format === 2) {
    // A backup of the split parts: put its parts back, drop parts it didn't have.
    const parts = await snap.ref.collection('parts').get();
    const ids = new Set(parts.docs.map(d => d.id));
    await inBatches(db, [
      ...liveNew.filter(d => !ids.has(partId(NEW, d.id)) && partId(NEW, d.id) !== '_meta').map(d => ({ ref: d.ref, del: true })),
      ...parts.docs.map(d => ({ ref: partRef(db, NEW, d.id), data: d.data() })),
      { ref: partRef(db, NEW, '_meta'), data: { v: 1, movedAt: new Date().toISOString(), restoredFrom: date } },
    ]);
  } else {
    // A backup from before the move: it goes back into the single document,
    // and removing the _meta markers makes the next device that opens the
    // site move it to the parts again (app.js load()).
    await db.doc(MAIN).set(snap.data().data);
    await partRef(db, NEW, '_meta').delete();
    await db.doc('appParts/_meta').delete();
  }
  res.status(200).send('Restored the app data from backup ' + date + ' (backed up at ' + backedUpAt + '). Refresh the site on every device.');
};
