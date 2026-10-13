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
const { getDb, getMessaging, dedupeTokenDocs, notifPrefAllows, isShabbatNow, isYomTovNow, sendViaEmailJS, notifEmailHtml } = require('../_lib/firebaseAdmin');
const { allOccasions } = require('../_lib/birthdayCalc');
const { sendWeeklyDebtReminders } = require('../_lib/weeklyDebtReminder');
const { flushPhoneQueue } = require('../_lib/yemot');

const BACKUP_RETENTION_DAYS = 30;

// "יוסי", "יוסי ורחל", "יוסי, רחל ודני"
const joinHe = a => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' ו' + a[a.length - 1];
// The title and text for one day's occasions (i: 0 today, 1 tomorrow), all
// names in one message, one line per kind.
function occasionText(list, i) {
  const kinds = { birthday: [], anniversary: [], yahrzeit: [] };
  list.forEach(b => (kinds[b.kind] || kinds.birthday).push(b.name));
  const lines = [], icons = [];
  const bd = kinds.birthday, an = kinds.anniversary, yz = kinds.yahrzeit;
  if (bd.length) { icons.push('🎂'); lines.push(i === 0 ? 'יום הולדת שמח ' + joinHe(bd.map(n => 'ל' + n)) + '!' : 'מחר ' + (bd.length > 1 ? 'ימי ההולדת' : 'יום ההולדת') + ' של ' + joinHe(bd)); }
  if (an.length) { icons.push('💍'); lines.push(i === 0 ? 'מזל טוב ' + joinHe(an.map(n => 'למשפחת ' + n)) + ' ליום הנישואין!' : 'מחר יום הנישואין של ' + joinHe(an.map(n => 'משפחת ' + n))); }
  if (yz.length) { icons.push('🕯️'); lines.push((i === 0 ? 'היום ' : 'מחר ') + 'היארצייט של ' + joinHe(yz)); }
  const when = i === 0 ? 'היום' : 'מחר';
  let title;
  if (icons.length > 1) title = '🎉 שמחות ' + when;
  else if (bd.length) title = '🎂 ' + (bd.length > 1 ? 'ימי הולדת' : 'יום הולדת') + ' ' + when + (i === 0 ? '!' : '');
  else if (an.length) title = '💍 ' + (an.length > 1 ? 'ימי נישואין' : 'יום נישואין') + ' ' + when + (i === 0 ? '!' : '');
  else title = '🕯️ יארצייט ' + when;
  return { title, body: lines.join(' · ') };
}

async function sendBirthdayReminders(db, data) {
  const all = allOccasions(data.families || [], data.yahrzeits || []);
  if (!all.length) return { occasions: 0, sent: 0 };

  // Registered emails (family+slot) that opted into email-instead-of-push
  // (see the 📧 toggle in app.js's notifPrefModal) for the 'birthday'
  // category — their own fcmTokens devices are excluded from the push loop
  // below, and they get an EmailJS send per occasion instead. This cron has
  // no live browser to drive the client's own EmailJS call, so it needs the
  // same publicKey/serviceId/templateId mirrored server-side
  // (settings/emailjs) that sendWeeklyDebtReminders already relies on.
  // Email and push are independent: a slot gets the email if it checked
  // birthdays, and its devices are dropped from push only if it also chose
  // "no push" (pref.push !== true — older prefs predate the choice and were
  // always email-instead-of-push).
  const emailSlots = new Set(), pushOffSlots = new Set();
  (data.families || []).forEach(f => {
    if (!f.notifEmailPref) return;
    [1, 2].forEach(slot => {
      const pref = f.notifEmailPref[slot]; if (!pref) return;
      if (pref.cats?.birthday) emailSlots.add(f.id + ':' + slot);
      if (pref.push !== true) pushOffSlots.add(f.id + ':' + slot);
    });
  });
  const ejsSnap = emailSlots.size ? await db.doc('settings/emailjs').get() : null;
  const ejsCreds = ejsSnap?.exists ? ejsSnap.data() : null;

  const tokSnap = await db.collection('fcmTokens').get();
  if (tokSnap.empty && !emailSlots.size) return { occasions: 0, sent: 0 };
  const tokenDocs = await dedupeTokenDocs(tokSnap.docs);
  const LINKS = {
    admin: 'https://yankeleviz.vercel.app/admin.html',
    index: 'https://yankeleviz.vercel.app/',
  };
  const groups = { admin: [], index: [] };
  tokenDocs.forEach(d => {
    const t = d.data();
    if (t.page !== 'admin' && t.famId != null && t.slot != null && pushOffSlots.has(t.famId + ':' + t.slot)) return;
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

  // One message per day (today / tomorrow) covering every occasion on it —
  // two birthdays on the same day used to send two emails and two pushes.
  // Each device gets the names its own "כולם/רק שלנו" choice allows.
  let sent = 0, occasions = 0;
  for (let i = 0; i <= 1; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const hd = parseInt(dayFmt.format(d)), hm = monthFmt.format(d);
    const todays = all.filter(x => x.hebDay === hd && hebMonthEq(x.hebMonth, hm));
    if (!todays.length) continue;
    occasions += todays.length;

    for (const [page, allDocs] of Object.entries(groups)) {
      // A family device's own notifPref only filters family-page pushes — the
      // admin device always gets everything. b.famId (yahrzeits have none) is
      // who a "רק שלנו" device needs to match.
      const byList = new Map();
      allDocs.forEach(doc => {
        const t = doc.data();
        const mine = page === 'index'
          ? todays.filter(b => notifPrefAllows(t.notifPref, 'birthday', b.famId != null ? [b.famId] : undefined, t.famId, undefined, { cats: t.pushCats, scopes: t.pushScopes }))
          : todays;
        if (!mine.length) return;
        const k = mine.map(b => todays.indexOf(b)).join(',');
        if (!byList.has(k)) byList.set(k, { list: mine, docs: [] });
        byList.get(k).docs.push(doc);
      });
      for (const { list, docs } of byList.values()) {
        const { title, body } = occasionText(list, i);
        try {
          // Data-only (no top-level `notification`) — see notify.js for why:
          // a notification payload gets auto-displayed by the browser's push
          // service AND by our own onBackgroundMessage handler, doubling it.
          const resp = await getMessaging().sendEachForMulticast({
            tokens: docs.map(x => x.data().token),
            data: { title, body, icon: 'https://yankeleviz.vercel.app/icon.jpg', link: LINKS[page] },
          });
          sent += resp.successCount;
          const dead = docs.filter((_, j) => !resp.responses[j]?.success);
          if (dead.length) {
            await Promise.all(dead.map(x => x.ref.delete()));
            groups[page] = groups[page].filter(x => !dead.includes(x));
          }
        } catch (e) {
          console.error(`dailyBackup: birthday push failed [${page}]`, e);
        }
      }
    }

    if (ejsCreds?.publicKey && ejsCreds?.serviceId && ejsCreds?.templateId) {
      const { title, body } = occasionText(todays, i);
      for (const key of emailSlots) {
        const [fidStr, slotStr] = key.split(':');
        const fam = (data.families || []).find(f => f.id === parseInt(fidStr));
        if (!fam) continue;
        const email = slotStr === '2' ? fam.email2 : fam.email;
        if (!email) continue;
        const famName = fam.name.replace('משפחת', '').trim();
        const html = notifEmailHtml(title.split(' ')[0], title, body);
        try {
          await sendViaEmailJS(ejsCreds.publicKey, ejsCreds.serviceId, ejsCreds.templateId, email, famName, title + ' · ינקלביץ', body, html);
          sent++;
        } catch (e) {
          console.error('dailyBackup: birthday email failed for', email, e);
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

  // Nothing runs on Shabbat or Yom Tov — no backup, no reminders, no debt
  // email. The schedule (vercel.json) fires daily at 6:00 UTC, which lands
  // Saturday morning in Israel (skipped by isShabbatNow) and would
  // otherwise also land during Rosh Hashana, Yom Kippur, Sukkot/Pesach's
  // first and last days, and Shavuot (skipped by isYomTovNow).
  if (isShabbatNow() || isYomTovNow()) { res.status(200).json({ ok: true, skipped: 'shabbat' }); return; }

  const db = getDb();
  const snap = await db.doc('appData/familyPayments').get();
  if (!snap.exists) { res.status(200).json({ ok: true, skipped: true }); return; }
  const data = snap.data();

  const today = new Date().toISOString().slice(0, 10);
  // The Shabbat log lives in its own doc (appData/shabbat) — back it up too.
  const shb = await db.doc('appData/shabbat').get();
  await db.doc(`backups/${today}`).set({ data, shabbat: shb.exists ? shb.data() : null, backedUpAt: new Date().toISOString() });

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

  // All of the morning's kosher-phone calls at once: the weekly debt reminder
  // and anything that came in during last night's quiet hours.
  let phoneCalls = {};
  try {
    phoneCalls = await flushPhoneQueue(db, debtReminders.phoneEntries || []);
  } catch (e) {
    console.error('dailyBackup: phone calls failed', e);
  }
  delete debtReminders.phoneEntries;

  res.status(200).json({ ok: true, date: today, deletedOld: old.docs.length, reminders, debtReminders, phoneCalls });
};
