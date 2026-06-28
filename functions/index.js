const {onSchedule} = require('firebase-functions/v2/scheduler');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');

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

exports.weeklyDebtReminder = onSchedule(
  {schedule: 'every day 08:00', timeZone: 'Asia/Jerusalem'},
  async () => {
    const db = getFirestore();

    const [cfgSnap, dataSnap] = await Promise.all([
      db.collection('appData').doc('emailConfig').get(),
      db.collection('appData').doc('familyPayments').get(),
    ]);

    if (!cfgSnap.exists || !dataSnap.exists) {
      console.log('Missing Firestore documents');
      return;
    }

    const cfg = cfgSnap.data();
    const {ejsPublicKey, ejsServiceId, ejsTemplateId, reminderDay = 0, lastDebtReminder = 0, ejsAppUrl = ''} = cfg;

    if (!ejsPublicKey || !ejsServiceId || !ejsTemplateId) {
      console.log('EmailJS not configured in Firestore');
      return;
    }

    const now = new Date();
    if (now.getDay() !== reminderDay) {
      console.log(`Today=${now.getDay()}, reminderDay=${reminderDay} — skip`);
      return;
    }

    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    if (lastDebtReminder >= todayMidnight.getTime()) {
      console.log('Already sent reminder today');
      return;
    }

    await cfgSnap.ref.update({lastDebtReminder: Date.now()});

    const {families = [], events = []} = dataSnap.data();
    let sent = 0;

    for (const f of families) {
      if (!f.email) continue;

      let totalDebt = 0;
      const debtTableRows = [];

      events.filter(e => e.open).forEach(ev => {
        const bal = (evAdjBalance(ev, families)[f.id] || 0);
        if (bal < -0.5) {
          const abs = Math.abs(bal);
          totalDebt += abs;
          debtTableRows.push([_esc(ev.name), `<span style="color:#ef4444;font-weight:700">₪${Math.round(abs).toLocaleString('he-IL')}</span>`]);
        }
      });

      if (totalDebt < 1) continue;

      const name = f.name.replace('משפחת', '').trim();
      const debtStr = `₪${Math.round(totalDebt).toLocaleString('he-IL')}`;
      const plainLines = debtTableRows.map(r => `• ${r[0]}: ${r[1].replace(/<[^>]+>/g, '')}`).join('\n');
      const msg = `שלום ${name},\n\nיתרת חוב כוללת: ${debtStr}\n\n${plainLines}\n\nכנס לאפליקציה לפרטים ולסידור התשלומים.`;

      let body = `<p style="margin:0 0 12px">שלום <strong>${_esc(name)}</strong>,</p>`;
      body += _eCard([['יתרת חוב כוללת', `<span style="color:#ef4444">${debtStr}</span>`, false]]);
      if (debtTableRows.length) body += _eTable(['אירוע', 'חוב'], debtTableRows);
      body += `<p style="color:#666;font-size:13px;text-align:center;margin:8px 0 0">כנס לאפליקציה לפרטים ולסידור התשלומים.</p>`;
      const html = _emailWrap(body, 'תזכורת חוב שבועית', '⏰', ejsAppUrl);
      const subject = '⏰ תזכורת שבועית · ינקלביץ';

      const emails = [f.email, f.email2].filter(Boolean);
      for (const email of emails) {
        try {
          await sendViaEmailJS(ejsPublicKey, ejsServiceId, ejsTemplateId, email, name, subject, msg, html);
          sent++;
        } catch (e) {
          console.error(`Failed to send to ${email}:`, e.message);
        }
      }
    }

    console.log(`Weekly reminder: sent to ${sent} addresses`);
  }
);
