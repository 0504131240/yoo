const CACHE = 'family-pay-v3';
const CORE = ['./','./index.html','./manifest.json','./icon.svg','./icon.jpg','./sw.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for Firebase, cache-first for app shell
  if (e.request.url.includes('firestore') || e.request.url.includes('firebase')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
  }
});
