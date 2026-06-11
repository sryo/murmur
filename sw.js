// Service worker: network-first for the app shell (so edits are never stale),
// cache-first for static assets. Bump VERSION to evict old caches.
const VERSION = 'v2';
const CACHE = `murmur-${VERSION}`;

// Cache-first: rarely-changing static assets
const STATIC = ['./ear.svg', './mouth.svg', './figure.svg', './manifest.json', './vendor/trystero-nostr.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isStatic = STATIC.some((p) => url.pathname.endsWith(p.slice(1)));

  if (isStatic) {
    // Cache-first, fall back to network and cache the result
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
      )
    );
    return;
  }

  // App shell (HTML/JS/CSS): network-first, fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
