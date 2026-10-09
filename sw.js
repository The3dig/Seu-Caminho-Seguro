// Service worker: deixa o app funcionando sem internet.
const VERSION = 'v23';
const APP = 'app-' + VERSION;
const TILES = 'tiles';
const MAX_TILES = 6000;

const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/geo.js', 'js/store.js', 'js/routing.js', 'js/pois.js',
  'js/radars.js', 'js/nav.js', 'js/voice.js', 'js/music.js', 'js/spotify.js', 'js/places.js', 'js/planner.js', 'js/config.js', 'js/cities.js', 'js/search.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Imagens do mapa: usa a cópia salva; se não tiver, baixa e guarda.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) { c.put(e.request, res.clone()); trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // APIs de rota/busca: sempre online (dados ficam salvos no IndexedDB).
  if (/nominatim|router\.project-osrm|routing\.openstreetmap|overpass|spotify|photon/.test(url.hostname)) return;

  // App: com internet pega sempre a versão mais nova (espera até 3 s);
  // sem internet ou sinal fraco, abre na hora pela cópia salva.
  e.respondWith((async () => {
    const cache = await caches.open(APP);
    const net = fetch(e.request).then((res) => {
      if (res.ok && (url.origin === location.origin || url.hostname === 'unpkg.com')) cache.put(e.request, res.clone());
      return res;
    });
    const timeout = new Promise((r) => setTimeout(r, 3000, null));
    try {
      const res = await Promise.race([net, timeout]);
      if (res) return res;
    } catch { /* offline */ }
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) { net.catch(() => {}); return hit; }
    try {
      return await net;
    } catch {
      if (e.request.mode === 'navigate') return cache.match('index.html');
      return new Response('', { status: 504 });
    }
  })());
});
