// Firebase Messaging — background push handler
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey:'AIzaSyA0MZMuGBBIXckhdiOZRZXRC_NPEte7pMA',
  authDomain:'yossi20361.firebaseapp.com',
  projectId:'yossi20361',
  storageBucket:'yossi20361.firebasestorage.app',
  messagingSenderId:'789621490367',
  appId:'1:789621490367:web:e62376e9d46a86903f7c0a'
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || 'ינקלביץ';
  const body  = payload.notification?.body  || '';
  // The server picks admin.html vs index.html per-recipient (see
  // api/notify.js) and sends it as fcmOptions.link — use that rather than
  // guessing from this script's own location, which is always "/" and used
  // to send admin-registered devices to the wrong page on click.
  const url = payload.fcmOptions?.link || (self.location.origin + '/');
  self.registration.showNotification(title, {
    body, icon:'/icon.jpg', dir:'rtl', lang:'he',
    data:{url}
  });
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || self.location.origin;
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true})
      .then(cls => {
        const exact = cls.find(c => c.url.startsWith(target));
        if (exact) return exact.focus();
        const anyOrigin = cls.find(c => c.url.startsWith(self.location.origin));
        return anyOrigin ? anyOrigin.focus() : clients.openWindow(target);
      })
  );
});

const CACHE = 'family-pay-v7';
const STATIC = ['./icon.svg','./icon.jpg','./manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Always network-first for HTML, Firebase, and the app's own code/styles —
  // these change on every deploy and must never be served stale from cache.
  if (url.includes('firestore') || url.includes('firebase') ||
      url.endsWith('/') || url.endsWith('.html') ||
      url.endsWith('.js') || url.endsWith('.css')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache-first only for truly static assets (images, icons, manifest)
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});
