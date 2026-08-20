// GET /api/cron/daily-backup — runs on Vercel's schedule (see vercel.json).
// Vercel signs its own cron requests with an Authorization header matching
// the CRON_SECRET env var; set CRON_SECRET in Vercel Project Settings so
// nobody else can trigger this by just guessing the URL.
const { getDb } = require('../_lib/firebaseAdmin');

const BACKUP_RETENTION_DAYS = 30;

module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = getDb();
  const snap = await db.doc('appData/familyPayments').get();
  if (!snap.exists) { res.status(200).json({ ok: true, skipped: true }); return; }

  const today = new Date().toISOString().slice(0, 10);
  await db.doc(`backups/${today}`).set({ data: snap.data(), backedUpAt: new Date().toISOString() });

  const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const old = await db.collection('backups').where('__name__', '<', db.doc(`backups/${cutoff}`)).get();
  await Promise.all(old.docs.map(d => d.ref.delete()));

  res.status(200).json({ ok: true, date: today, deletedOld: old.docs.length });
};
