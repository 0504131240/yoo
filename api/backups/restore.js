// GET /api/backups/restore?date=YYYY-MM-DD&confirm=YES&adminPass=... —
// DESTRUCTIVE: fully overwrites appData/familyPayments with a past backup.
const { getDb, checkAdminPass } = require('../_lib/firebaseAdmin');

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
  const backupData = snap.data().data;
  await db.doc('appData/familyPayments').set(backupData);
  res.status(200).send('Restored appData/familyPayments from backup ' + date + ' (backed up at ' + snap.data().backedUpAt + ')');
};
