const CACHE_NAME = 'azilut-flota-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './flota-nube.js',
  'https://cdn.tailwindcss.com',
  'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Firebase (gstatic / googleapis) va siempre a la red, nunca a caché.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    return; // red directa
  }
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});