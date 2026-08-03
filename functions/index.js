const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');
const {onDocumentUpdated} = require('firebase-functions/v2/firestore');

initializeApp();

// --- Push Notifications ---

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

  if(!notifications.length) return null;

  const db = getFirestore();
  const snap = await db.collection('fcmTokens').get();
  if(snap.empty) return null;

  const tokenDocs = snap.docs;
  const tokens = tokenDocs.map(d=>d.data().token).filter(Boolean);
  if(!tokens.length) return null;

  const notif = notifications[0];
  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: {title:notif.title, body:notif.body},
    webpush: {
      notification: {icon:'https://0504131240.github.io/yoo/icon.jpg', dir:'rtl', lang:'he'},
      fcmOptions: {link:'https://0504131240.github.io/yoo/'}
    }
  });

  // מחק tokens לא תקינים
  const toDelete = tokenDocs.filter((_,i)=>!resp.responses[i]?.success);
  await Promise.all(toDelete.map(d=>d.ref.delete()));
  return null;
});
