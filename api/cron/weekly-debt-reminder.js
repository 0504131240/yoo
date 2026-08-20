// GET /api/cron/weekly-debt-reminder — runs on Vercel's schedule (see
// vercel.json). Same CRON_SECRET protection as daily-backup.
const { getDb } = require('../_lib/firebaseAdmin');
const { evAdjBalance } = require('../_lib/debtCalc');

function _escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendViaEmailJS(publicKey, serviceId, templateId, toEmail, toName, subject, message, messageHtml) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: { to_email: toEmail, to_name: toName, subject, message, message_html: messageHtml },
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
      <a href="https://yankeleviz.vercel.app/" style="display:inline-block;background:#1E88D8;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700">פתח באפליקציה ←</a>
    </td></tr>
    </table></td></tr></table></body></html>`;
  return { message, html };
}

module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = getDb();
  const [dataSnap, ejsSnap] = await Promise.all([
    db.doc('appData/familyPayments').get(),
    db.doc('settings/emailjs').get(),
  ]);
  if (!dataSnap.exists) { res.status(200).json({ ok: true, skipped: true }); return; }
  const { publicKey, serviceId, templateId } = ejsSnap.exists ? ejsSnap.data() : {};
  if (!publicKey || !serviceId || !templateId) { res.status(200).json({ ok: true, skipped: 'no emailjs settings' }); return; }

  const data = dataSnap.data();
  const families = data.families || [];
  const openEvents = (data.events || []).filter(e => e.open);
  if (!openEvents.length) { res.status(200).json({ ok: true, skipped: 'no open events' }); return; }

  const debtsByFam = {};
  openEvents.forEach(ev => {
    const adjBal = evAdjBalance(ev, families);
    ev.participants.forEach(fid => {
      const owe = Math.round(-(adjBal[fid] || 0));
      if (owe > 0.5) {
        if (!debtsByFam[fid]) debtsByFam[fid] = [];
        debtsByFam[fid].push({ name: ev.name, owe });
      }
    });
  });

  let sentCount = 0;
  for (const [fidStr, debts] of Object.entries(debtsByFam)) {
    const fam = families.find(f => f.id === parseInt(fidStr));
    if (!fam) continue;
    const addrs = [fam.email, fam.email2].filter(Boolean);
    if (!addrs.length) continue;
    const famName = fam.name.replace('משפחת', '').trim();
    const totalDebt = debts.reduce((s, d) => s + d.owe, 0);
    const { message, html } = debtEmailContent(famName, debts, totalDebt);
    for (const email of addrs) {
      try {
        await sendViaEmailJS(publicKey, serviceId, templateId, email, famName, '⚠️ תזכורת שבועית: חוב פתוח · ינקלביץ', message, html);
        sentCount++;
      } catch (e) {
        console.error('weeklyDebtReminder email failed for', email, e);
      }
    }
  }

  res.status(200).json({ ok: true, sent: sentCount });
};
