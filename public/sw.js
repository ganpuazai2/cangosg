// Service worker: makes the app open instantly and work as an installed app.
// - App shell + stop list: served from cache, refreshed in the background
// - Live data (/api/*): always from the network, never cached
// - Map tiles: cached as you browse (capped)

const VERSION = "gosg-v20";
const SHELL = [
  "/", "/index.html", "/app.js", "/manifest.webmanifest", "/stops.json", "/services.json",
  "/icons/icon-192.png", "/icons/apple-touch-icon.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];
const TILES = "gosg-tiles";
const MAX_TILES = 400;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
  const net = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || (req.mode === "navigate" ? cache.match("/") : Response.error());
}

// The page and app code: newest from the network first, saved copy only when offline,
// so an old page never mixes with new code
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch {
    return (await cache.match(req, { ignoreSearch: req.mode === "navigate" })) || (req.mode === "navigate" ? cache.match("/") : Response.error());
  }
}

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) {
    cache.put(req, r.clone());
    cache.keys().then((keys) => { if (keys.length > MAX_TILES) keys.slice(0, keys.length - MAX_TILES).forEach((k) => cache.delete(k)); });
  }
  return r;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req).catch(() =>
      new Response(JSON.stringify({ error: "You're offline" }), { status: 503, headers: { "content-type": "application/json" } })));
    return;
  }
  if (url.pathname.startsWith("/_vercel/")) return; // analytics: let it pass
  if (url.hostname === "www.onemap.gov.sg" && url.pathname.startsWith("/maps/tiles/")) {
    e.respondWith(tile(req).catch(() => Response.error()));
    return;
  }
  if (url.origin === location.origin && (req.mode === "navigate" || /\.(js|html|webmanifest)$/.test(url.pathname))) {
    e.respondWith(networkFirst(req));
    return;
  }
  if (url.origin === location.origin || ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req));
  }
});

// Tapping a "time to go" reminder brings the app back to the front
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow("/"))));
});
