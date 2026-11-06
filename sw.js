// Offline cache for the measurement page. Only fetches the page's own files.
const CACHE = 'pc-spike-7';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'worker.js', 'lib/grouping.js', 'lib/report.js', 'lib/aac.js', 'lib/control.js', 'lib/mp4date.js', 'lib/timeline.js', 'lib/mp4edit.js', 'lib/persist.js', 'videoA.js', 'vendor/mp4box/mp4box.all.js', 'vendor/mp4box/styp-BV5G3FS-.js', 'vendor/mp4box/rolldown-runtime-CNh9ExCG.js', 'vendor/mp4-muxer/mp4-muxer.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
// Network first (so a re-upload shows up at once), cache as the offline fallback.
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
