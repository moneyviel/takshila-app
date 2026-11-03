// Takshila service worker: makes the app installable and opens fast.
// Pages load fresh from the network first; the saved copy is used only when offline.
// Live data (Supabase) is never cached.
const CACHE = 'takshila-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.hostname.endsWith('supabase.co')) return;            // never cache live data
  const shellFile = u.origin === location.origin;
  const cdn = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.hostname);
  if (!shellFile && !cdn) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; })
    .catch(() => caches.match(r).then(m => m || (r.mode === 'navigate' ? caches.match('./index.html') : undefined))));
});
