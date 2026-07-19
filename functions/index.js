const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');
const {onDocumentUpdated} = require('firebase-functions/v2/firestore');

initializeApp();

// --- Ported calculation logic ---

const FAM_ADULTS = 2;

function famWeight(f, method, childOverride) {
  if (!f) return 1;
  const ch = childOverride != null ? childOverride : (f.children || 0);
  if (method === 'percapita') return FAM_ADULTS + ch;
  if (method === 'weighted') return FAM_ADULTS + ch * 0.5;
  return 1;
}

function evCost(ev) {
  if (ev.totalCost != null) return ev.totalCost;
  return ev.participants.reduce((s, fid) => s + (ev.expenses[fid] || 0), 0);
}

function evShares(ev, families) {
  const getFam = id => families.find(f => f.id === id);
  const method = ev.splitMethod || 'equal';
  const totalCost = evCost(ev);
  const partialItems = (ev.expenseItems || []).filter(
    it => it.sharedWith && it.sharedWith.length > 0 && it.sharedWith.length < ev.participants.length
  );
  const partialAmt = partialItems.reduce((s, it) => s + it.amt, 0);
  const globalCost = totalCost - partialAmt;
  let totalW = 0;
  const w = {};
  ev.participants.forEach(fid => {
    w[fid] = famWeight(getFam(fid), method, ev.childOverrides?.[fid]);
    totalW += w[fid];
  });
  if (!totalW) return Object.fromEntries(ev.participants.map(fid => [fid, 0]));
  const exact = {};
  ev.participants.forEach(fid => { exact[fid] = globalCost * (w[fid] / totalW); });
  partialItems.forEach(it => {
    const sw = it.sharedWith.filter(fid => ev.participants.includes(fid));
    if (!sw.length) return;
    sw.forEach(fid => { exact[fid] = (exact[fid] || 0) + it.amt / sw.length; });
  });
  const floors = {};
  ev.participants.forEach(fid => { floors[fid] = Math.floor(exact[fid] || 0); });
  let remainder = Math.round(totalCost - ev.participants.reduce((s, fid) => s + floors[fid], 0));
  const sorted = [...ev.participants].sort(
    (a, b) => ((exact[b] || 0) - floors[b]) - ((exact[a] || 0) - floors[a])
  );
  const shares = {...floors};
  for (let i = 0; i < remainder && i < sorted.length; i++) shares[sorted[i]]++;
  return shares;
}

function evAdjBalance(ev, families) {
  const shares = evShares(ev, families);
  const adjBal = {};
  ev.participants.forEach(fid => { adjBal[fid] = (ev.expenses[fid] || 0) - (shares[fid] || 0); });
  (ev.settled || []).forEach(s => {
    const fromFid = ev.participants.find(fid => {
      const f = families.find(x => x.id === fid);
      return f && f.name.replace('משפחת', '').trim() === s.from;
    });
    const toFid = ev.participants.find(fid => {
      const f = families.find(x => x.id === fid);
      return f && f.name.replace('משפחת', '').trim() === s.to;
    });
    if (fromFid != null) adjBal[fromFid] = (adjBal[fromFid] || 0) + s.amt;
    if (toFid != null) adjBal[toFid] = (adjBal[toFid] || 0) - s.amt;
  });
  (ev.potPayments || []).forEach(p => { adjBal[p.famId] = (adjBal[p.famId] || 0) + p.amt; });
  return adjBal;
}

// --- Email HTML helpers ---

function _esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _emailWrap(bodyHtml, headerTitle, headerIcon, url) {
  const linkRow = url
    ? `<tr><td style="background:#fff;padding:0 24px 24px;text-align:center"><a href="${_esc(url)}" style="display:inline-block;background:#5b4fcf;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:700">פתח באפליקציה ←</a></td></tr>`
    : '';
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:12px;background:#eef0f8;font-family:-apple-system,Helvetica,Arial,sans-serif;direction:rtl"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" style="width:100%;max-width:560px" cellspacing="0" cellpadding="0"><tr><td style="background:linear-gradient(135deg,#5b4fcf 0%,#8b5cf6 100%);padding:28px 24px;text-align:center;border-radius:10px 10px 0 0"><div style="font-size:38px;margin-bottom:6px">${headerIcon}</div><div style="color:#fff;font-size:20px;font-weight:700">ינקלביץ</div><div style="color:rgba(255,255,255,0.82);font-size:13px;margin-top:4px">${_esc(headerTitle)}</div></td></tr><tr><td style="background:#fff;padding:24px;direction:rtl;color:#1a1a2e;font-size:15px;line-height:1.65">${bodyHtml}</td></tr>${linkRow}<tr><td style="background:#f4f4f6;padding:10px 24px;text-align:center;border-radius:0 0 10px 10px;border-top:1px solid #e4e4e8"><span style="font-size:11px;color:#aaa">ינקלביץ · מערכת ניהול הוצאות משפחתית</span></td></tr></table></td></tr></table></body></html>`;
}

function _eCard(rows) {
  return '<div style="background:#f6f7ff;border:1px solid #e0e2ff;border-radius:8px;padding:14px 16px;margin-bottom:16px">' +
    rows.map(([l, v, hi], i) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0${i < rows.length - 1 ? ';border-bottom:1px solid #ecedff' : ''}"><span style="color:#666;font-size:14px">${_esc(l)}</span><span style="font-weight:700;font-size:14px${hi ? ';color:#5b4fcf' : ''}">${v}</span></div>`
    ).join('') + '</div>';
}

function _eTable(headers, rows) {
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px"><tr style="background:#edeeff">${headers.map(h => `<th style="padding:8px 10px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #d8d8f0">${_esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr style="border-bottom:1px solid #f0f0f6">${r.map((c, i) => `<td style="padding:7px 10px${i > 0 ? ';font-weight:600' : ''}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
}

// --- EmailJS REST API ---

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

// --- Scheduled Function ---

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
