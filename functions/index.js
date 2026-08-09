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
// ⚠️ PORTED LOGIC — kept in sync with app.js by hand, on purpose.
// evShares/evCost/evAdjBalance/famWeight below are copies of the same-named
// functions in app.js. If the calculation logic changes there (split
// methods, savings rounding, settled-entry matching, pot handling...),
// update these too or this email will quietly report the wrong amount.
const FAM_ADULTS = 2;

function famWeight(f, method, childOverride, parentOverride) {
  if (!f) return 1;
  const ch = childOverride != null ? childOverride : (f.children || 0);
  const adults = parentOverride != null ? parentOverride : FAM_ADULTS;
  if (method === 'percapita') return adults + ch;
  if (method === 'weighted') return adults + ch * 0.5;
  return 1;
}
function evPotExpTotal(ev) { return (ev.potExpItems || []).reduce((s, it) => s + it.amt, 0); }
function evCost(ev) {
  return (ev.totalCost != null ? ev.totalCost : ev.participants.reduce((s, fid) => s + (ev.expenses[fid] || 0), 0)) + evPotExpTotal(ev);
}
function evSavingsPerFam(ev) { return ev.savingsTotal ? Math.round(ev.savingsTotal / ((ev.participants || []).length || 1)) : 0; }
function evShares(ev, families) {
  const getFam = id => families.find(f => f.id === id);
  const method = ev.splitMethod || 'equal';
  const totalCost = evCost(ev);
  const partialItems = (ev.expenseItems || []).filter(it =>
    it.customSplit || (it.sharedWith && it.sharedWith.length > 0 && it.sharedWith.length < ev.participants.length)
  );
  const partialAmt = partialItems.reduce((s, it) => s + it.amt, 0);
  const globalCost = totalCost - partialAmt;
  let totalW = 0; const w = {};
  ev.participants.forEach(fid => { w[fid] = famWeight(getFam(fid), method, ev.childOverrides?.[fid], ev.parentOverrides?.[fid]); totalW += w[fid]; });
  if (!totalW) return Object.fromEntries(ev.participants.map(fid => [fid, 0]));
  const exact = {};
  ev.participants.forEach(fid => { exact[fid] = globalCost * (w[fid] / totalW); });
  partialItems.forEach(it => {
    if (it.customSplit) {
      Object.entries(it.customSplit).forEach(([fid, a]) => { const nfid = parseInt(fid); if (ev.participants.includes(nfid)) exact[nfid] = (exact[nfid] || 0) + a; });
    } else {
      const sw = it.sharedWith.filter(fid => ev.participants.includes(fid));
      if (!sw.length) return;
      sw.forEach(fid => { exact[fid] = (exact[fid] || 0) + it.amt / sw.length; });
    }
  });
  const floors = {};
  ev.participants.forEach(fid => { floors[fid] = Math.floor(exact[fid] || 0); });
  let remainder = Math.round(totalCost - ev.participants.reduce((s, fid) => s + floors[fid], 0));
  const sorted = [...ev.participants].sort((a, b) => ((exact[b] || 0) - floors[b]) - ((exact[a] || 0) - floors[a]));
  const hasSavings = !!ev.savingsTotal;
  const shares = {...floors};
  if (hasSavings) {
    ev.participants.forEach(fid => { shares[fid] = Math.ceil(exact[fid] || 0); });
  } else {
    for (let i = 0; i < remainder && i < sorted.length; i++) shares[sorted[i]]++;
  }
  const savingsPerFam = evSavingsPerFam(ev);
  if (savingsPerFam > 0) ev.participants.forEach(fid => { shares[fid] = (shares[fid] || 0) + savingsPerFam; });
  return shares;
}
function evBalance(ev, families) {
  const shares = evShares(ev, families);
  const res = {};
  ev.participants.forEach(fid => { res[fid] = (ev.expenses[fid] || 0) - (shares[fid] || 0); });
  return res;
}
function evAdjBalance(ev, families) {
  const getFam = id => families.find(f => f.id === id);
  const adjBal = evBalance(ev, families);
  (ev.settled || []).forEach(s => {
    const fromFid = ev.participants.find(fid => { const f = getFam(fid); return f && f.name.replace('משפחת', '').trim() === s.from; });
    const toFid = ev.participants.find(fid => { const f = getFam(fid); return f && f.name.replace('משפחת', '').trim() === s.to; });
    if (fromFid != null) adjBal[fromFid] = (adjBal[fromFid] || 0) + s.amt;
    if (toFid != null) adjBal[toFid] = (adjBal[toFid] || 0) - s.amt;
  });
  (ev.potPayments || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  (ev.savingsPaid || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  return adjBal;
}

function _escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

async function sendViaEmailJS(publicKey, serviceId, templateId, toEmail, toName, subject, message, messageHtml) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {to_email: toEmail, to_name: toName, subject, message, message_html: messageHtml},
    }),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
}

function debtEmailContent(famName, debts, totalDebt) {
  const message = `שלום ${famName},\n\nתזכורת שבועית — יש לך חוב פתוח באפליקציה:\n\n` +
    debts.map(d => `${d.name}: ₪${d.owe.toLocaleString()}`).join('\n') +
    `\n\nסה"כ: ₪${totalDebt.toLocaleString()}`;
  const rows = debts.map(d =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${_escHtml(d.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:left;font-weight:700">₪${d.owe.toLocaleString()}</td></tr>`
  ).join('');
  const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"></head><body style="margin:0;padding:12px;background:#eef0f8;font-family:-apple-system,Helvetica,Arial,sans-serif;direction:rtl">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" style="width:100%;max-width:480px;background:#fff;border-radius:10px;overflow:hidden" cellspacing="0" cellpadding="0">
    <tr><td style="background:linear-gradient(135deg,#0C447C,#1E88D8);padding:20px;text-align:center">
      <div style="font-size:28px">📋</div><div style="color:#fff;font-size:17px;font-weight:700">תזכורת שבועית · ינקלביץ</div>
    </td></tr>
    <tr><td style="padding:20px">
      <p style="margin:0 0 12px;font-size:14px;color:#333">שלום ${_escHtml(famName)},</p>
      <p style="margin:0 0 14px;font-size:14px;color:#333">יש לך חוב פתוח באפליקציה:</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>
      <div style="margin-top:14px;padding:10px 14px;background:#FEF2F2;border-radius:8px;text-align:center">
        <span style="font-weight:700;color:#A32D2D">סה"כ: ₪${totalDebt.toLocaleString()}</span>
      </div>
    </td></tr>
    <tr><td style="padding:0 20px 20px;text-align:center">
      <a href="https://0504131240.github.io/yoo/" style="display:inline-block;background:#1E88D8;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700">פתח באפליקציה ←</a>
    </td></tr>
    </table></td></tr></table></body></html>`;
  return {message, html};
}

exports.weeklyDebtReminder = onSchedule(
  {schedule: 'every sunday 09:00', timeZone: 'Asia/Jerusalem', region: 'me-west1'},
  async () => {
    const db = getFirestore();
    const [dataSnap, ejsSnap] = await Promise.all([
      db.doc('appData/familyPayments').get(),
      db.doc('settings/emailjs').get(),
    ]);
    if (!dataSnap.exists) return;
    const {publicKey, serviceId, templateId} = ejsSnap.exists ? ejsSnap.data() : {};
    if (!publicKey || !serviceId || !templateId) return;

    const data = dataSnap.data();
    const families = data.families || [];
    const openEvents = (data.events || []).filter(e => e.open);
    if (!openEvents.length) return;

    const debtsByFam = {};
    openEvents.forEach(ev => {
      const adjBal = evAdjBalance(ev, families);
      ev.participants.forEach(fid => {
        const owe = Math.round(-(adjBal[fid] || 0));
        if (owe > 0.5) {
          if (!debtsByFam[fid]) debtsByFam[fid] = [];
          debtsByFam[fid].push({name: ev.name, owe});
        }
      });
    });

    for (const [fidStr, debts] of Object.entries(debtsByFam)) {
      const fam = families.find(f => f.id === parseInt(fidStr));
      if (!fam) continue;
      const addrs = [fam.email, fam.email2].filter(Boolean);
      if (!addrs.length) continue;
      const famName = fam.name.replace('משפחת', '').trim();
      const totalDebt = debts.reduce((s, d) => s + d.owe, 0);
      const {message, html} = debtEmailContent(famName, debts, totalDebt);
      for (const email of addrs) {
        try {
          await sendViaEmailJS(publicKey, serviceId, templateId, email, famName, '⚠️ תזכורת שבועית: חוב פתוח · ינקלביץ', message, html);
        } catch (e) {
          console.error('weeklyDebtReminder email failed for', email, e);
        }
      }
    }
  }
);
