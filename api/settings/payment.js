// GET /api/settings/payment — public, returns the treasurer's payment details
//   (every family needs these to know where to send money).
// POST /api/settings/payment — saves them, gated by the app's admin password.
//
// Goes through the Admin SDK (bypassing Firestore security rules entirely)
// instead of the client SDK's direct settings/payment read/write, which
// depends on those rules staying correctly configured for this one
// collection — same reasoning as the existing /api/backups endpoints.
const { getDb, checkAdminPass } = require('../_lib/firebaseAdmin');

module.exports = async (req, res) => {
  const db = getDb();
  const ref = db.doc('settings/payment');

  if (req.method === 'GET') {
    const snap = await ref.get();
    res.status(200).json(snap.exists ? snap.data() : {});
    return;
  }

  if (req.method === 'POST') {
    const { adminPass, name, bank, branch, account, bit } = req.body || {};
    if (!(await checkAdminPass(db, adminPass))) { res.status(401).json({ error: 'unauthorized' }); return; }
    const p = { name: name || '', bank: bank || '', branch: branch || '', account: account || '', bit: bit || '' };
    await ref.set(p);
    res.status(200).json(p);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
