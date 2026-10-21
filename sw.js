/* Gym Log service worker: caches the whole app on first visit so it runs with no signal.
   To ship an update: change any file, then bump VERSION below. The app shows "Update ready". */
const VERSION = 'gymlog-v1.0.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './logic.js',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache so a new VERSION never stores stale files.
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
  );
  // First install: take over right away. Updates wait until the user taps "Update".
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gymlog-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Page loads (including from the home-screen icon): always answer from cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        cache.match('./index.html').then((hit) => hit || fetch(req)))
    );
    return;
  }

  // Everything else: cache first, network as a fallback (and remember what we fetched).
  event.respondWith(
    caches.open(VERSION).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        });
      }))
  );
});
