// Shared Firebase Admin SDK setup for Vercel serverless functions.
// Requires these env vars (Vercel Project Settings → Environment Variables),
// taken from a Firebase service account key (Firebase Console → Project
// Settings → Service Accounts → Generate new private key):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (keep the \n escapes as-is when pasting)
const admin = require('firebase-admin');

// Rebuilds a clean, valid PEM from whatever survived the trip through a
// dashboard paste box — copy/pasting a private key is notorious for losing
// or mangling line breaks (literal "\n" turning into nothing, real
// newlines getting collapsed, stray wrapping quotes...), which then fails
// deep inside the gRPC/OpenSSL layer with an opaque
// "DECODER routines::unsupported" error. Re-deriving the PEM structure from
// just the base64 body sidesteps all of that, as long as the base64
// content itself made it through intact.
function _normalizePrivateKey(raw) {
  let key = (raw || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\n/g, '\n');
  const m = key.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (m) {
    const body = m[1].replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) || [];
    key = '-----BEGIN PRIVATE KEY-----\n' + lines.join('\n') + '\n-----END PRIVATE KEY-----\n';
  }
  return key;
}

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const privateKey = _normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

function getDb() {
  getAdminApp();
  return admin.firestore();
}

function getMessaging() {
  getAdminApp();
  return admin.messaging();
}

// Same trust model as the app itself: the family's own admin password
// (stored on appData/familyPayments) gates access, failing closed if no
// admin password has been set yet.
async function checkAdminPass(db, supplied) {
  const snap = await db.doc('appData/familyPayments').get();
  const real = snap.exists ? snap.data().adminPass : '';
  return !!real && !!supplied && supplied === real;
}

// Collapse duplicate fcmTokens docs that share the exact same push token —
// e.g. the client's localStorage device id was reset (site data cleared,
// PWA reinstalled...) so a new doc got created, but the browser's
// underlying push subscription — and therefore the token itself — stayed
// the same, leaving both the old and new doc valid and delivering every
// push twice to the same device. Keeps whichever doc was registered most
// recently and deletes the rest, so this self-heals the next time any push
// fires — no separate cleanup job needed.
// Note: this only catches two docs with an identical token value. Two
// genuinely different push subscriptions on the same physical phone (e.g.
// an installed PWA and a regular browser tab, which each get their own
// token) look like two different devices and can't be merged from the data
// alone.
async function dedupeTokenDocs(docs) {
  const byToken = new Map();
  docs.forEach(d => {
    const data = d.data();
    if (!data.token) return;
    const existing = byToken.get(data.token);
    if (!existing || (data.ts || 0) > (existing.data().ts || 0)) byToken.set(data.token, d);
  });
  const keep = new Set([...byToken.values()].map(d => d.id));
  const stale = docs.filter(d => d.data().token && !keep.has(d.id));
  if (stale.length) {
    await Promise.all(stale.map(d => d.ref.delete().catch(() => {})));
  }
  return [...byToken.values()];
}

// A family device can choose (via the 🔔 button, see notifPrefModal in
// app.js) how much it wants pushed to it: 'all' (default — every push,
// unchanged), 'important' (skips chat/poll noise) or 'mine' (skips anything
// not about this family's own events, per relatedFamIds). Only ever applied
// to family-page ('index') devices — admin devices always get everything,
// regardless of what's stored in their own notifPref field.
function notifPrefAllows(pref, kind, relatedFamIds, famId) {
  const p = pref || 'all';
  if (p === 'all') return true;
  if (kind === 'chat' || kind === 'poll') return false;
  if (p === 'important') return true;
  if (p === 'mine') return Array.isArray(relatedFamIds) && famId != null && relatedFamIds.includes(famId);
  return true;
}

module.exports = { getDb, getMessaging, checkAdminPass, dedupeTokenDocs, notifPrefAllows };
