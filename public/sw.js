// Caches the app shell so it opens instantly and survives a dead connection.
// Live data is never cached -- a stale box score is worse than none.
const SHELL = 'bt-shell-v6';
const FILES = ['/', '/index.html', '/styles.css', '/app.js', '/markets.js', '/sync.js', '/config.js', '/import-prompt.js', '/scores.js', '/feed.js', '/fantasy.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;      // always live
  if (url.origin !== self.location.origin) return;   // team logos etc.

  // Network first so a deploy lands immediately, cache as the offline fallback.
  // Bypass the HTTP cache explicitly: a stale app.js served to an installed
  // home-screen app is far worse than one extra round trip.
  const fresh = new Request(e.request.url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: e.request.headers,
    mode: e.request.mode === 'navigate' ? 'same-origin' : e.request.mode,
    redirect: 'follow',
  });

  e.respondWith(
    fetch(fresh)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
