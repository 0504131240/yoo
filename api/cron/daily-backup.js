// GET /api/cron/daily-backup — runs on Vercel's schedule (see vercel.json).
// Vercel signs its own cron requests with an Authorization header matching
// the CRON_SECRET env var; set CRON_SECRET in Vercel Project Settings so
// nobody else can trigger this by just guessing the URL.
//
// Also sends the daily birthday/anniversary/yahrzeit reminder push here
// (bundled into the same once-a-day cron rather than a separate one — the
// Vercel Hobby plan caps a project at 2 cron jobs, and this project already
// has 2). This replaces the old client-side checkBirthdayNotifs(), which
// only ran when someone happened to open the app that day — if nobody did,
// the reminder silently never went out even on the exact day.
const { getDb, getMessaging } = require('../_lib/firebaseAdmin');
const { allOccasions } = require('../_lib/birthdayCalc');

const BACKUP_RETENTION_DAYS = 30;

async function sendBirthdayReminders(db, data) {
  const all = allOccasions(data.families || [], data.yahrzeits || []);
  if (!all.length) return { occasions: 0, sent: 0 };

  const tokSnap = await db.collection('fcmTokens').get();
  if (tokSnap.empty) return { occasions: 0, sent: 0 };
  const LINKS = {
    admin: 'https://yankeleviz.vercel.app/admin.html',
    index: 'https://yankeleviz.vercel.app/',
  };
  const groups = { admin: [], index: [] };
  tokSnap.docs.forEach(d => {
    const t = d.data();
    if (!t.token) return;
    groups[t.page === 'admin' ? 'admin' : 'index'].push(d);
  });

  const dayFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn', { day: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { month: 'long' });
  const today = new Date();

  let sent = 0, occasions = 0;
  for (let i = 0; i <= 1; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const hd = parseInt(dayFmt.format(d)), hm = monthFmt.format(d);
    for (const b of all.filter(x => x.hebDay === hd && x.hebMonth === hm)) {
      occasions++;
      const isAnniv = b.kind === 'anniversary';
      const isYahrzeit = b.kind === 'yahrzeit';
      const title = isYahrzeit ? (i === 0 ? '🕯️ יארצייט היום' : '🕯️ יארצייט מחר')
        : isAnniv ? (i === 0 ? '💍 יום נישואין היום!' : '💍 יום נישואין מחר')
        : (i === 0 ? '🎂 יום הולדת היום!' : '🎂 יום הולדת מחר');
      const body = isYahrzeit ? (i === 0 ? 'היום היארצייט של ' + b.name : 'מחר היארצייט של ' + b.name)
        : isAnniv ? (i === 0 ? 'מזל טוב למשפחת ' + b.name + '!' : 'מחר יום הנישואין של משפחת ' + b.name)
        : (i === 0 ? 'יום הולדת שמח ל' + b.name + '!' : 'מחר יום ההולדת של ' + b.name);

      for (const [page, docs] of Object.entries(groups)) {
        if (!docs.length) continue;
        try {
          const resp = await getMessaging().sendEachForMulticast({
            tokens: docs.map(d => d.data().token),
            notification: { title, body },
            webpush: {
              notification: { icon: 'https://yankeleviz.vercel.app/icon.jpg', dir: 'rtl', lang: 'he' },
              fcmOptions: { link: LINKS[page] },
            },
          });
          sent += resp.successCount;
          const dead = docs.filter((_, i) => !resp.responses[i]?.success);
          if (dead.length) {
            await Promise.all(dead.map(d => d.ref.delete()));
            groups[page] = docs.filter((_, i) => resp.responses[i]?.success);
          }
        } catch (e) {
          console.error(`dailyBackup: birthday push failed [${page}]`, e);
        }
      }
    }
  }
  return { occasions, sent };
}

module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = getDb();
  const snap = await db.doc('appData/familyPayments').get();
  if (!snap.exists) { res.status(200).json({ ok: true, skipped: true }); return; }
  const data = snap.data();

  const today = new Date().toISOString().slice(0, 10);
  await db.doc(`backups/${today}`).set({ data, backedUpAt: new Date().toISOString() });

  const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const old = await db.collection('backups').where('__name__', '<', db.doc(`backups/${cutoff}`)).get();
  await Promise.all(old.docs.map(d => d.ref.delete()));

  let reminders = { occasions: 0, sent: 0 };
  try {
    reminders = await sendBirthdayReminders(db, data);
  } catch (e) {
    console.error('dailyBackup: birthday reminder step failed', e);
  }

  res.status(200).json({ ok: true, date: today, deletedOld: old.docs.length, reminders });
};
