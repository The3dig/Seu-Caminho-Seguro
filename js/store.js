// Armazenamento offline (IndexedDB): configurações, viagens, radares e músicas.
const DB_NAME = 'seu-caminho-seguro';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('kv');
        db.createObjectStore('tracks', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k) => tx('kv', 'readwrite', (s) => s.delete(k)),
};

export const tracks = {
  all: () => tx('tracks', 'readonly', (s) => s.getAll()),
  put: (t) => tx('tracks', 'readwrite', (s) => s.put(t)),
  del: (id) => tx('tracks', 'readwrite', (s) => s.delete(id)),
};

export const DEFAULT_SETTINGS = {
  appName: 'Seu Caminho Seguro',
  voice: true,
  beep: true,
  alertDist: [1000, 500, 200],
  fatigueMin: 120,
  fuelGapKm: 60,
  poiRadius: 400,
  introMusic: true,
  musicSource: 'spotify', // 'spotify' (se conectado) ou 'local'
  spotifyClientId: '',
  spotifyItem: null, // { uri, name, kind, url }
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await kv.get('settings')) || {}) };
}

export function saveSettings(s) {
  return kv.set('settings', s);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function listTrips() {
  return (await kv.get('trips')) || [];
}

export async function saveTrip(trip) {
  const list = (await listTrips()).filter((t) => t.id !== trip.id);
  list.unshift({ id: trip.id, name: trip.name, created: trip.created, distance: trip.distance, duration: trip.duration });
  await kv.set('trip:' + trip.id, trip);
  await kv.set('trips', list);
}

export async function loadTrip(id) {
  return kv.get('trip:' + id);
}

export async function deleteTrip(id) {
  await kv.del('trip:' + id);
  await kv.set('trips', (await listTrips()).filter((t) => t.id !== id));
}
