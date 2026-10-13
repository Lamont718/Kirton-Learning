/* Makes "works offline" true rather than optimistic.
   A parent logs on a couch, on a phone, on whatever signal is in the room. The
   app is one HTML file, so caching it is the whole job — and the record itself
   was never on a server to begin with. */
const CACHE = 'record-v2'
/* The page lives at "/record" — the address Vercel actually serves. v1 cached
   "./" and "./index.html", which are "/record/" and "/record/index.html": both
   308 to "/record", so what it held was two redirects and no page. */
const PAGE = '/record'
const SHELL = [PAGE, '/record/manifest.webmanifest']

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
        // Only a real page is worth keeping: a redirect or an error stored here
        // is what would be handed back with no signal.
        if (res.ok && !res.redirected) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((hit) => hit || (e.request.mode === 'navigate' ? caches.match(PAGE) : undefined))
        .then((hit) => hit || Response.error()))
  )
})
