// GET /api/cron/daily-backup — runs on Vercel's schedule (see vercel.json).
// Vercel signs its own cron requests with an Authorization header matching
// the CRON_SECRET env var; set CRON_SECRET in Vercel Project Settings so
// nobody else can trigger this by just guessing the URL.
//
// Also sends the daily birthday/anniversary/yahrzeit reminder push, AND
// (Sundays only) the weekly debt reminder email/push — both bundled into
// this same once-a-day cron rather than their own separate entries.
// vercel.json lists three cron paths, but empirically Vercel's Hobby plan
// only ever actually registers ONE of a project's cron entries (confirmed
// via the dashboard's Cron Jobs tab, which listed just this one) — the
// other two were silently never invoked, which is why the weekly debt email
// never went out and the old client-side birthday check (which only ran if
// someone happened to open the app that day) was the sole source of that
// reminder. Doing all three here, gated by day-of-week where relevant, is
// the only way that's actually reliable on this plan.
const { getDb, getMessaging, dedupeTokenDocs } = require('../_lib/firebaseAdmin');
const { allOccasions } = require('../_lib/birthdayCalc');
const { sendWeeklyDebtReminders } = require('./weekly-debt-reminder');

const BACKUP_RETENTION_DAYS = 30;

async function sendBirthdayReminders(db, data) {
  const all = allOccasions(data.families || [], data.yahrzeits || []);
  if (!all.length) return { occasions: 0, sent: 0 };

  const tokSnap = await db.collection('fcmTokens').get();
  if (tokSnap.empty) return { occasions: 0, sent: 0 };
  const tokenDocs = await dedupeTokenDocs(tokSnap.docs);
  const LINKS = {
    admin: 'https://yankeleviz.vercel.app/admin.html',
    index: 'https://yankeleviz.vercel.app/',
  };
  const groups = { admin: [], index: [] };
  tokenDocs.forEach(d => {
    const t = d.data();
    groups[t.page === 'admin' ? 'admin' : 'index'].push(d);
  });

  const dayFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn', { day: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { month: 'long' });
  const today = new Date();
  // Intl renders Adar as plain "אדר" in a regular year but "אדר א׳"/"אדר ב׳" in a
  // leap year — an occasion saved in one kind of year never string-equals today's
  // month name in the other, silently skipping it for years at a time. Treat any
  // Adar variant as interchangeable (same fix as app.js's calendar matching).
  const hebMonthEq = (a, b) => a === b || (!!a && !!b && a.startsWith('אדר') && b.startsWith('אדר'));

  let sent = 0, occasions = 0;
  for (let i = 0; i <= 1; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const hd = parseInt(dayFmt.format(d)), hm = monthFmt.format(d);
    for (const b of all.filter(x => x.hebDay === hd && hebMonthEq(x.hebMonth, hm))) {
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
  // Fail closed, not open: if CRON_SECRET is ever missing from Vercel's env
  // (unset, wrong environment scope), this used to let the request through
  // for anyone who found the URL, silently triggering full data backups,
  // birthday pushes, and (Sundays) debt-reminder emails on demand.
  const auth = req.headers['authorization'];
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
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

  let debtReminders = { skipped: 'not sunday' };
  if (new Date().getUTCDay() === 0) {
    try {
      debtReminders = await sendWeeklyDebtReminders(db, data);
    } catch (e) {
      console.error('dailyBackup: weekly debt reminder step failed', e);
    }
  }

  res.status(200).json({ ok: true, date: today, deletedOld: old.docs.length, reminders, debtReminders });
};
