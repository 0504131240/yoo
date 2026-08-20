// Shared Firebase Admin SDK setup for Vercel serverless functions.
// Requires these env vars (Vercel Project Settings → Environment Variables),
// taken from a Firebase service account key (Firebase Console → Project
// Settings → Service Accounts → Generate new private key):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (keep the \n escapes as-is when pasting)
const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.apps[0];
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
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
