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
  self.registration.showNotification(title, {
    body, icon:'/icon.jpg', dir:'rtl', lang:'he',
    data:{url: self.location.origin + self.location.pathname.replace(/\/[^/]*$/,'/')}
  });
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || self.location.origin;
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true})
      .then(cls => { const w=cls.find(c=>c.url.startsWith(self.location.origin)); return w?w.focus():clients.openWindow(target); })
  );
});

const CACHE = 'family-pay-v6';
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
  // Always network-first for HTML and Firebase
  if (url.includes('firestore') || url.includes('firebase') ||
      url.endsWith('/') || url.endsWith('.html')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache-first only for static assets (images, icons)
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});
