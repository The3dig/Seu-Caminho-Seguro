// Banco de radares pessoal. Cada radar acumula confirmações e negações feitas
// durante as viagens; radares negados repetidamente deixam de alertar.
import { kv, uid } from './store.js';
import { dist } from './geo.js';

let cache = null;

// Além de radares, a base guarda perigos fixos que você marca na estrada
// (campo kind; sem kind = radar). Avisam do mesmo jeito, sem internet.
export const HAZARDS = {
  buraco: { icon: '🕳️', word: 'Buraco', name: 'buraco' },
  lombada: { icon: '🚧', word: 'Lombada', name: 'lombada' },
  perigo: { icon: '⚠️', word: 'Perigo', name: 'trecho perigoso' },
};
export const isHazard = (r) => !!(r && r.kind && HAZARDS[r.kind]);

export async function all() {
  if (!cache) cache = (await kv.get('radars')) || [];
  return cache;
}

async function persist() {
  await kv.set('radars', cache);
}

export function isActive(r) {
  return !(r.denials >= 2 && r.denials > r.confirmations);
}

export function status(r) {
  if (!isActive(r)) return 'inativo';
  if (r.confirmations >= 2) return 'confirmado';
  if (r.confirmations === 1) return 'visto 1x';
  return r.source === 'osm' ? 'do mapa (não confirmado)' : 'novo';
}

function findNear(list, p, maxM = 40, kind = null) {
  let best = null, bestD = maxM;
  for (const r of list) {
    if ((r.kind || null) !== (kind || null)) continue; // buraco não se junta com radar
    const d = dist(r, p);
    if (d <= bestD) { best = r; bestD = d; }
  }
  return best;
}

export async function add({ lat, lon, limit = null, heading = null, source = 'meu', osmId = null, note = '', kind = null }) {
  const list = await all();
  const near = findNear(list, { lat, lon }, 35, kind);
  if (near) {
    near.confirmations++;
    near.lastSeen = Date.now();
    if (limit && !near.limit) near.limit = limit;
    if (heading != null && near.heading == null) near.heading = heading;
    await persist();
    return near;
  }
  const r = {
    id: uid(), lat, lon, limit, heading, source, osmId, note,
    ...(kind ? { kind } : {}),
    confirmations: source === 'meu' ? 1 : 0,
    denials: 0,
    created: Date.now(),
    lastSeen: source === 'meu' ? Date.now() : null,
  };
  list.push(r);
  await persist();
  return r;
}

export async function mergeOSM(osmRadars) {
  const list = await all();
  let added = 0;
  for (const o of osmRadars) {
    if (list.some((r) => r.osmId === o.osmId) || findNear(list, o, 40)) continue;
    list.push({
      id: uid(), lat: o.lat, lon: o.lon, limit: o.limit, heading: o.heading,
      source: 'osm', osmId: o.osmId, note: '',
      confirmations: 0, denials: 0, created: Date.now(), lastSeen: null,
    });
    added++;
  }
  if (added) await persist();
  return added;
}

export async function update(id, patch) {
  const r = (await all()).find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch);
  await persist();
  return r;
}

export async function confirm(id) {
  const r = (await all()).find((x) => x.id === id);
  if (!r) return;
  r.confirmations++;
  r.lastSeen = Date.now();
  // Um radar confirmado de novo "perdoa" negações antigas.
  if (r.denials > 0) r.denials--;
  await persist();
}

export async function deny(id) {
  const r = (await all()).find((x) => x.id === id);
  if (!r) return;
  r.denials++;
  await persist();
}

export async function remove(id) {
  cache = (await all()).filter((r) => r.id !== id);
  await persist();
}

export async function replaceAll(list) {
  cache = list;
  await persist();
}

// ---------- Importação / exportação ----------

export function exportJSON(list) {
  return JSON.stringify({ app: 'seu-caminho-seguro', version: 1, radars: list }, null, 1);
}

export function exportCSV(list) {
  const rows = ['lat,lon,limite,sentido,confirmacoes,negacoes,origem'];
  for (const r of list) rows.push([r.lat, r.lon, r.limit ?? '', r.heading ?? '', r.confirmations, r.denials, r.source].join(','));
  return rows.join('\n');
}

// Lê JSON (backup), CSV (lat,lon[,limite]), GPX (wpt) ou KML (Placemark/Point).
export function parseImport(text, filename = '') {
  const out = [];
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    const data = JSON.parse(t);
    const arr = Array.isArray(data) ? data : data.radars || [];
    for (const r of arr) if (isFinite(r.lat) && isFinite(r.lon)) out.push(r);
    return out;
  }
  if (t.startsWith('<') || /\.(gpx|kml)$/i.test(filename)) {
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    for (const w of doc.querySelectorAll('wpt')) {
      const name = w.querySelector('name')?.textContent || '';
      out.push({ lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), limit: limitFrom(name), note: name });
    }
    for (const pm of doc.querySelectorAll('Placemark')) {
      const c = pm.querySelector('Point coordinates');
      if (!c) continue;
      const [lon, lat] = c.textContent.trim().split(',').map(Number);
      const name = pm.querySelector('name')?.textContent || '';
      out.push({ lat, lon, limit: limitFrom(name), note: name });
    }
    return out.filter((r) => isFinite(r.lat) && isFinite(r.lon));
  }
  for (const line of t.split(/\r?\n/)) {
    const parts = line.split(/[;,\t]/).map((s) => s.trim());
    const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push({ lat, lon, limit: parseInt(parts[2], 10) || null, heading: parseFloat(parts[3]) >= 0 ? parseFloat(parts[3]) : null });
  }
  return out;
}

function limitFrom(name) {
  const m = name.match(/(\d{2,3})\s*(km|$)/i);
  return m ? parseInt(m[1], 10) : null;
}

export async function importList(items) {
  const list = await all();
  let added = 0;
  for (const it of items) {
    const kind = HAZARDS[it.kind] ? it.kind : null;
    if (findNear(list, it, 30, kind)) continue;
    list.push({
      ...(kind ? { kind } : {}),
      id: uid(), lat: +it.lat, lon: +it.lon, limit: it.limit ?? null, heading: it.heading ?? null,
      source: it.source || 'importado', osmId: it.osmId || null, note: it.note || '',
      confirmations: it.confirmations ?? 0, denials: it.denials ?? 0,
      created: it.created || Date.now(), lastSeen: it.lastSeen || null,
    });
    added++;
  }
  await persist();
  return added;
}
