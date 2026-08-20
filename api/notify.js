// POST /api/notify — sends a real push notification (via FCM) to every
// registered device. Called directly by the client (app.js addNotif) right
// after it writes a change to Firestore, replacing the old Firebase Cloud
// Function that triggered on every appData/familyPayments update.
//
// Gated by the app's own admin password (same trust boundary as the rest of
// the app's shared-family data) so random internet traffic can't spam pushes
// to the family.
const { getDb, getMessaging, checkAdminPass } = require('./_lib/firebaseAdmin');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { adminPass, title, body } = req.body || {};
  if (!title || !body) { res.status(400).json({ error: 'title and body required' }); return; }

  const db = getDb();
  if (!(await checkAdminPass(db, adminPass))) { res.status(401).json({ error: 'unauthorized' }); return; }

  const tokSnap = await db.collection('fcmTokens').get();
  console.log(`notify: ${tokSnap.size} registered token(s) found`);
  if (tokSnap.empty) { res.status(200).json({ sent: 0, registered: 0 }); return; }

  // Devices registered from admin.html should land back on admin.html when
  // the notification is tapped, not on the public family page (and vice
  // versa) — registerFCMToken() records which page each token came from.
  const LINKS = {
    admin: 'https://yankeleviz.vercel.app/admin.html',
    index: 'https://yankeleviz.vercel.app/',
  };
  const groups = { admin: [], index: [] };
  tokSnap.docs.forEach(d => {
    const data = d.data();
    if (!data.token) return;
    (groups[data.page === 'admin' ? 'admin' : 'index']).push(d);
  });

  let sent = 0, registered = 0, deleted = 0;
  for (const [page, docs] of Object.entries(groups)) {
    if (!docs.length) continue;
    registered += docs.length;
    const resp = await getMessaging().sendEachForMulticast({
      tokens: docs.map(d => d.data().token),
      notification: { title, body },
      webpush: {
        notification: { icon: 'https://yankeleviz.vercel.app/icon.jpg', dir: 'rtl', lang: 'he' },
        fcmOptions: { link: LINKS[page] },
      },
    });
    sent += resp.successCount;
    resp.responses.forEach((r, i) => {
      if (!r.success) console.log(`notify[${page}]: token ${i} failed — ${r.error?.code || r.error?.message || 'unknown error'}`);
    });
    const toDelete = docs.filter((_, i) => !resp.responses[i]?.success);
    deleted += toDelete.length;
    await Promise.all(toDelete.map(d => d.ref.delete()));
  }

  console.log(`notify: sent ${sent}/${registered}, removed ${deleted} invalid token(s)`);
  res.status(200).json({ sent, registered });
};
