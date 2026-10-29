// GET /api/backups/list?adminPass=... — read-only, lists available backup
// dates with a quick summary of each (family/event counts) so you can tell
// which one to restore without guessing.
const { getDb, checkAdminPass } = require('../_lib/firebaseAdmin');

module.exports = async (req, res) => {
  const db = getDb();
  if (!(await checkAdminPass(db, req.query.adminPass))) {
    res.status(401).send('Unauthorized — pass ?adminPass=<the app admin password>');
    return;
  }
  const snap = await db.collection('backups').orderBy('__name__', 'desc').limit(30).get();
  const list = snap.docs.map(d => {
    const b = d.data();
    const data = b.data || {};
    return {
      date: d.id,
      backedUpAt: b.backedUpAt,
      families: b.format === 2 ? (b.summary || {}).families : (data.families || []).length,
      events: b.format === 2 ? (b.summary || {}).events : (data.events || []).length,
    };
  });
  res.status(200).json(list);
};
