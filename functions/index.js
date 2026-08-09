const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');
const {onDocumentUpdated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');

initializeApp();

const BACKUP_RETENTION_DAYS = 30;

// --- Daily Backup ---

exports.dailyBackup = onSchedule(
  {schedule: 'every day 03:00', timeZone: 'Asia/Jerusalem', region: 'me-west1'},
  async () => {
    const db = getFirestore();
    const snap = await db.doc('appData/familyPayments').get();
    if (!snap.exists) return;
    const today = new Date().toISOString().slice(0, 10);
    await db.doc(`backups/${today}`).set({data: snap.data(), backedUpAt: new Date().toISOString()});

    const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const old = await db.collection('backups').where('__name__', '<', db.doc(`backups/${cutoff}`)).get();
    await Promise.all(old.docs.map(d => d.ref.delete()));
  }
);

// --- Push Notifications ---

async function sendPushToAll(db, title, body) {
  const snap = await db.collection('fcmTokens').get();
  if (snap.empty) return;
  const tokenDocs = snap.docs;
  const tokens = tokenDocs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) return;

  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: {title, body},
    webpush: {
      notification: {icon: 'https://0504131240.github.io/yoo/icon.jpg', dir: 'rtl', lang: 'he'},
      fcmOptions: {link: 'https://0504131240.github.io/yoo/'}
    }
  });

  // מחק tokens לא תקינים
  const toDelete = tokenDocs.filter((_, i) => !resp.responses[i]?.success);
  await Promise.all(toDelete.map(d => d.ref.delete()));
}

exports.sendPushOnUpdate = onDocumentUpdated(
  {document: 'appData/familyPayments', region: 'me-west1'},
  async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();
  const notifications = [];

  // הודעות חדשות
  const newMsgs = (after.messages||[]).filter(m => !(before.messages||[]).find(b=>b.id===m.id));
  newMsgs.forEach(m => notifications.push({
    title:'💬 הודעה חדשה', body:(m.author?m.author+': ':'')+m.text
  }));

  // אירועים חדשים
  const newEvs = (after.events||[]).filter(e => !(before.events||[]).find(b=>b.id===e.id));
  newEvs.forEach(e => notifications.push({title:'📅 אירוע חדש', body:e.name}));

  // הוצאות חדשות
  const countExps = evs => (evs||[]).reduce((s,e)=>s+(e.expenseItems||[]).length,0);
  if(countExps(after.events) > countExps(before.events))
    notifications.push({title:'💰 הוצאה חדשה', body:'נוספה הוצאה חדשה לאירוע'});

  // אישורי תשלום חדשים
  const newClaims = (after.paymentClaims||[]).filter(c => !(before.paymentClaims||[]).find(b=>b.id===c.id));
  newClaims.forEach(c => notifications.push({title:'💸 אישור תשלום חדש', body:`₪${c.amt} · לבדיקה באפליקציה`}));

  if(!notifications.length) return null;

  const db = getFirestore();
  const notif = notifications[0];
  await sendPushToAll(db, notif.title, notif.body);
  return null;
});

// --- Weekly Debt Reminder ---
// A generic nudge, not a personalized amount — computing exact per-family
// balances requires the full share/settlement logic that only lives in
// app.js (splitting methods, pot transfers, settled entries...). Duplicating
// that here would drift out of sync the moment it changes there, so this
// just points people back to the app instead of guessing at a number.
exports.weeklyDebtReminder = onSchedule(
  {schedule: 'every friday 10:00', timeZone: 'Asia/Jerusalem', region: 'me-west1'},
  async () => {
    const db = getFirestore();
    const snap = await db.doc('appData/familyPayments').get();
    if (!snap.exists) return;
    const data = snap.data();
    const hasOpenEvents = (data.events || []).some(e => e.open);
    if (!hasOpenEvents) return;
    await sendPushToAll(db, '📋 תזכורת שבועית', 'יש אירועים פתוחים — כדאי לבדוק אם יש לך חוב באפליקציה');
  }
);
