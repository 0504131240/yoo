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

module.exports = { getDb, getMessaging, checkAdminPass };
