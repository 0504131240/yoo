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
  const tokenDocs = tokSnap.docs;
  const tokens = tokenDocs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) { res.status(200).json({ sent: 0 }); return; }

  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: {
      notification: { icon: 'https://yankeleviz.vercel.app/icon.jpg', dir: 'rtl', lang: 'he' },
      fcmOptions: { link: 'https://yankeleviz.vercel.app/' },
    },
  });

  const toDelete = tokenDocs.filter((_, i) => !resp.responses[i]?.success);
  await Promise.all(toDelete.map(d => d.ref.delete()));

  res.status(200).json({ sent: resp.successCount });
};
