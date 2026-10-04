const CACHE_NAME = 'stock-ledger-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/app.js', '/styles.css'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never touch API calls or non-GET requests — those always need live data,
  // and the offline sale queue (handled in app.js) depends on their real
  // network failures reaching the page, not a cached/fake response.
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;

  // Network-first for the app shell: always try to get the latest code first,
  // and only fall back to the cached copy when there's genuinely no connection.
  // This means an online user never gets stuck on stale cached code after a deploy.
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html')))
  );
});
