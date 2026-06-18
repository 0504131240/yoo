const CACHE = 'family-pay-v4';
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
