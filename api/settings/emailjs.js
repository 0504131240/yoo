// GET /api/settings/emailjs — public, returns the EmailJS credentials the
//   client needs to send mail directly from the browser via the EmailJS SDK.
// POST /api/settings/emailjs — saves them, gated by the app's admin password.
//
// Goes through the Admin SDK (bypassing Firestore security rules entirely)
// instead of the client SDK's direct settings/emailjs read/write, which
// depends on those rules staying correctly configured for this one
// collection — same reasoning as the existing /api/backups endpoints.
const { getDb, checkAdminPass } = require('../_lib/firebaseAdmin');

module.exports = async (req, res) => {
  const db = getDb();
  const ref = db.doc('settings/emailjs');

  if (req.method === 'GET') {
    const snap = await ref.get();
    res.status(200).json(snap.exists ? snap.data() : {});
    return;
  }

  if (req.method === 'POST') {
    const { adminPass, publicKey, serviceId, templateId } = req.body || {};
    if (!(await checkAdminPass(db, adminPass))) { res.status(401).json({ error: 'unauthorized' }); return; }
    const d = { publicKey: publicKey || '', serviceId: serviceId || '', templateId: templateId || '' };
    await ref.set(d);
    res.status(200).json(d);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
