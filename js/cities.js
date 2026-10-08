// Diário de cidades: registra por onde você passou e onde parou, para montar
// o relatório "cidades que conheço". Funciona offline: guarda os pontos numa
// fila e descobre o nome da cidade quando houver internet.
import { kv } from './store.js';
import { dist } from './geo.js';
import { placeAt } from './routing.js';

const CHECK_EVERY_M = 4000; // um ponto a cada ~4 km rodados
let lastPt = null;
let working = false;
const listeners = new Set();

export function onChange(fn) { listeners.add(fn); }
const emit = () => { for (const fn of listeners) fn(); };

export async function all() {
  return (await kv.get('cities')) || [];
}

// Todas as leituras/escritas da fila e do diário passam por esta trava, para
// que pontos chegando ao mesmo tempo não sobrescrevam uns aos outros.
let lock = Promise.resolve();
function locked(fn) {
  const p = lock.then(fn);
  lock = p.catch(() => {});
  return p;
}

async function queue() {
  return (await kv.get('cityQueue')) || [];
}

function enqueue(item) {
  return locked(async () => {
    const q = await queue();
    q.push(item);
    await kv.set('cityQueue', q.slice(-3000));
  }).then(() => process());
}

export function resetTrack() { lastPt = null; }

// Chamado a cada posição do GPS durante a navegação.
export function track(fix) {
  const p = { lat: fix.lat, lon: fix.lon };
  if (lastPt && dist(lastPt, p) < CHECK_EVERY_M) return;
  lastPt = p;
  enqueue({ lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4), t: Date.now(), stop: false });
}

// Parada registrada (sono, café…) conta como "parou na cidade".
export function markStop(pt, reason) {
  enqueue({ lat: +pt.lat.toFixed(4), lon: +pt.lon.toFixed(4), t: Date.now(), stop: true, reason });
}

// Registro manual: "estou aqui".
export function checkIn(pt) {
  enqueue({ lat: +pt.lat.toFixed(4), lon: +pt.lon.toFixed(4), t: Date.now(), stop: true, reason: 'check-in' });
}

// Varre o histórico de viagens já gravadas (pontos a cada ~5 km).
export async function importTracks(drives) {
  let n = 0;
  for (const d of drives) {
    if (!d?.track?.length) continue;
    let last = null;
    for (const [lat, lon] of d.track) {
      const p = { lat, lon };
      if (last && dist(last, p) < 5000) continue;
      last = p;
      await enqueue0({ lat, lon, t: d.start, stop: false });
      n++;
    }
    for (const s of d.stops || []) { await enqueue0({ lat: s.lat, lon: s.lon, t: s.start, stop: true, reason: s.reason }); n++; }
  }
  process();
  return n;
}

function enqueue0(item) {
  return locked(async () => {
    const q = await queue();
    q.push(item);
    await kv.set('cityQueue', q);
  });
}

export async function pending() {
  return (await queue()).length;
}

const day = (t) => new Date(t).toISOString().slice(0, 10);
export const keyOf = (c) => `${c.city}|${c.uf || c.state}|${c.countryCode || ''}`;

function upsert(place, item) {
  return locked(() => upsert0(place, item));
}

async function upsert0(place, item) {
  if (!place.city) return;
  const list = await all();
  const key = keyOf(place);
  let c = list.find((x) => x.key === key);
  if (!c) {
    c = { key, city: place.city, uf: place.uf, state: place.state, country: place.country, countryCode: place.countryCode,
      lat: item.lat, lon: item.lon, first: item.t, last: item.t, days: [], stopped: false, stops: 0, reasons: {} };
    list.push(c);
  }
  c.first = Math.min(c.first, item.t);
  c.last = Math.max(c.last, item.t);
  const d = day(item.t);
  if (!c.days.includes(d)) c.days.push(d);
  if (item.stop) {
    c.stopped = true;
    c.stops++;
    if (item.reason) c.reasons[item.reason] = (c.reasons[item.reason] || 0) + 1;
  }
  await kv.set('cities', list);
}

// Processa a fila: 1 consulta por segundo (regra do serviço de mapas).
// Pontos muito perto de uma cidade já resolvida reaproveitam o resultado.
const cacheNear = [];
export async function process() {
  if (working || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  working = true;
  try {
    for (;;) {
      const item = await locked(async () => (await queue())[0]);
      if (!item) break;
      let place = cacheNear.find((c) => dist(c, item) < 1500)?.place;
      if (!place) {
        try {
          place = await placeAt(item.lat, item.lon);
        } catch {
          break; // sem internet: tenta de novo mais tarde
        }
        cacheNear.push({ lat: item.lat, lon: item.lon, place });
        if (cacheNear.length > 200) cacheNear.shift();
        await new Promise((r) => setTimeout(r, 1100));
      }
      await upsert(place, item);
      await locked(async () => {
        const q2 = await queue();
        if (q2[0] && q2[0].t === item.t && q2[0].lat === item.lat) q2.shift();
        await kv.set('cityQueue', q2);
      });
      emit();
    }
  } finally {
    working = false;
  }
}

if (typeof window !== 'undefined') window.addEventListener('online', () => process());

export function remove(key) {
  return locked(async () => kv.set('cities', (await all()).filter((c) => c.key !== key)));
}

export function clear() {
  return locked(async () => {
    await kv.set('cities', []);
    await kv.set('cityQueue', []);
  });
}

export function stats(list) {
  const states = new Set(list.map((c) => c.uf || c.state));
  const countries = new Set(list.map((c) => c.countryCode || c.country));
  return { cities: list.length, stopped: list.filter((c) => c.stopped).length, states: states.size, countries: countries.size };
}
