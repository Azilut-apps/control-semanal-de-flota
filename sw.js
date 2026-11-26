const CACHE_NAME = 'azilut-flota-v5';

// Solo archivos estáticos externos van a caché (CDNs pesados que no cambian).
const ASSETS_EXTERNOS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Archivos propios de la app: SIEMPRE van a la red primero.
const ARCHIVOS_PROPIOS = [
  './',
  './index.html',
  './flota-nube.js',
  './manifest.json'
];

// Install: solo pre-cachear CDNs externos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_EXTERNOS))
      .then(() => self.skipWaiting())
  );
});

// Activate: borrar cachés viejos e invalidar archivos propios
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: estrategia diferenciada
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase y Google: siempre a la red
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    return;
  }

  // Archivos propios de la app (index.html, flota-nube.js, etc.): RED PRIMERO
  const esPropio = ARCHIVOS_PROPIOS.some(a => event.request.url.includes(a.replace('./', '')))
    || url.hostname === 'azilut-apps.github.io';

  if (esPropio) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Guardar copia fresca en caché como respaldo
          const copia = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copia));
          return response;
        })
        .catch(() => caches.match(event.request)) // Si no hay red, usar caché
    );
    return;
  }

  // CDNs externos: caché primero
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
