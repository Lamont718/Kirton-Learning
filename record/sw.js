/* Makes "works offline" true rather than optimistic.
   A parent logs on a sofa, on a phone, on whatever signal is in the room. The
   app is one HTML file, so caching it is the whole job — and the record itself
   was never on a server to begin with. */
const CACHE = 'record-v1'
const SHELL = ['./', './index.html', './manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

/* Network first so a deployed fix reaches her, cache second so no signal never
   means no app. Only same-origin GETs — nothing here should ever be proxying
   anything else. */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {})
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  )
})
