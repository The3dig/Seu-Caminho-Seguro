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

export const count = () => (cache ? cache.length : 0);

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
  return r.source === 'osm' ? 'do mapa (não confirmado)' : r.source === 'importado' ? 'importado (não confirmado)' : 'novo';
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
// ---------- Importar arquivos de radares ----------
// Aceita: backup do app (JSON), CSV/TXT (Garmin "lon,lat,nome", iGO
// "X,Y,TYPE,SPEED,DIRTYPE,DIRECTION", ou "lat,lon,limite"), GPX, KML,
// TomTom .ov2 e .zip com qualquer um desses dentro (ex.: Maparadar).
export async function parseFile(file) {
  const name = file.name || '';
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) { // "PK" = zip
    const out = [];
    for (const f of await unzip(buf)) {
      if (!/\.(csv|txt|gpx|kml|ov2|json)$/i.test(f.name)) continue;
      out.push(...parseBytes(f.data, f.name));
    }
    return out;
  }
  return parseBytes(buf, name);
}

function parseBytes(buf, name) {
  if (/\.ov2$/i.test(name)) return parseOV2(buf);
  // Arquivos antigos de GPS costumam vir em Latin-1, não UTF-8.
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  return parseImport(text, name);
}

// TomTom OV2: registros [tipo 1 byte][tamanho 4][lon*1e5 4][lat*1e5 4][nome\0].
function parseOV2(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let i = 0;
  while (i + 13 <= buf.length) {
    const type = buf[i];
    if (type === 1) { i += 21; continue; } // bloco de índice
    const len = dv.getInt32(i + 1, true);
    if (len < 13 || i + len > buf.length) break;
    if (type === 2 || type === 3) {
      const lon = dv.getInt32(i + 5, true) / 1e5, lat = dv.getInt32(i + 9, true) / 1e5;
      let end = i + 13;
      while (end < i + len && buf[end]) end++;
      const label = new TextDecoder('windows-1252').decode(buf.subarray(i + 13, end));
      out.push({ lat, lon, limit: limitFrom(label), note: label.slice(0, 60) });
    }
    i += len;
  }
  return out.filter(okBR);
}

// Zip mínimo (lê o diretório central e descompacta com o próprio navegador).
async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip inválido');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const fname = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(ds).arrayBuffer());
    } else continue;
    files.push({ name: fname, data });
  }
  return files;
}

const okBR = (r) => isFinite(r.lat) && isFinite(r.lon) && r.lat > -35 && r.lat < 7 && r.lon > -75 && r.lon < -28;

// Divide uma linha de CSV respeitando aspas.
function splitCSV(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseImport(text, filename = '') {
  const out = [];
  const t = text.replace(/^﻿/, '').trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    const data = JSON.parse(t);
    const arr = Array.isArray(data) ? data : data.radars || [];
    for (const r of arr) if (isFinite(r.lat) && isFinite(r.lon)) out.push(r);
    return out;
  }
  if (t.startsWith('<') || /\.(gpx|kml)$/i.test(filename)) {
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    for (const w of doc.querySelectorAll('wpt')) {
      const name = [w.querySelector('name')?.textContent, w.querySelector('desc')?.textContent].filter(Boolean).join(' ');
      out.push({ lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), limit: limitFrom(name), note: name.slice(0, 60) });
    }
    for (const pm of doc.querySelectorAll('Placemark')) {
      const c = pm.querySelector('Point coordinates');
      if (!c) continue;
      const [lon, lat] = c.textContent.trim().split(',').map(Number);
      const name = pm.querySelector('name')?.textContent || '';
      out.push({ lat, lon, limit: limitFrom(name), note: name.slice(0, 60) });
    }
    return out.filter((r) => isFinite(r.lat) && isFinite(r.lon));
  }
  // CSV/TXT: descobre o separador, o cabeçalho (se tiver) e a ordem lat/lon.
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(#|\/\/|;)/.test(l));
  const sep = [';', '\t', ','].find((c) => (lines[0] || '').includes(c) && (lines[1] || lines[0]).includes(c)) || ',';
  let col = null; // índices vindos do cabeçalho
  for (const line of lines) {
    const parts = splitCSV(line, sep);
    if (!col && parts.some((x) => /^(x|y|lat|lon|lng|latitude|longitude|speed|velocidade|limite)$/i.test(x))) {
      const f = (rx) => parts.findIndex((x) => rx.test(x));
      col = { x: f(/^(x|lon|lng|longitude)$/i), y: f(/^(y|lat|latitude)$/i), speed: f(/^(speed|velocidade|vel|limite|limit|maxspeed)$/i),
        dirtype: f(/^dirtype$/i), dir: f(/^(direction|heading|dir|sentido|angulo)$/i) };
      continue;
    }
    let lat, lon, limit = null, heading = null;
    if (col && col.x >= 0 && col.y >= 0) {
      lon = parseFloat(parts[col.x]); lat = parseFloat(parts[col.y]);
      if (col.speed >= 0) limit = parseInt(parts[col.speed], 10) || null;
      const dt = col.dirtype >= 0 ? parseInt(parts[col.dirtype], 10) : 1;
      const dir = col.dir >= 0 ? parseFloat(parts[col.dir]) : NaN;
      if (dt === 1 && dir >= 0 && dir <= 360) heading = dir; // só quando vale para um sentido
    } else {
      const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
      if (!isFinite(a) || !isFinite(b)) continue;
      // No Brasil a longitude é sempre menor que -34; a latitude, maior.
      if (a < -34 && b >= -34) { lon = a; lat = b; } else { lat = a; lon = b; }
      const rest = parts.slice(2);
      const n = parseInt(rest[0], 10);
      if (n >= 20 && n <= 130 && /^\d+$/.test(rest[0])) {
        limit = n; // "lat,lon,limite,sentido" (formato do próprio app)
        const h = parseFloat(rest[1]);
        if (h >= 0 && h <= 360) heading = h;
      } else limit = limitFrom(rest.join(' '));
    }
    const r = { lat, lon, limit, heading, note: parts.slice(2).join(' ').replace(/"/g, '').slice(0, 60) };
    if (okBR(r)) out.push(r);
  }
  return out;
}

// "Radar 60 km/h", "@60", "Vel. 80", "60km" → 60.
function limitFrom(name) {
  const m = String(name).match(/(?:@|vel\.?\s*|limite\s*)(\d{2,3})|(\d{2,3})\s*(?:km|kmh|km\/h)\b/i);
  const v = m ? parseInt(m[1] || m[2], 10) : null;
  return v >= 20 && v <= 130 ? v : null;
}

export async function importList(items) {
  const list = await all();
  // Grade de ~200 m para checar duplicados rápido (bases com dezenas de milhares).
  const key = (lat, lon) => `${Math.round(lat * 500)},${Math.round(lon * 500)}`;
  const grid = new Map();
  const put = (r) => { const k = key(r.lat, r.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(r); };
  list.forEach(put);
  const near = (it, kind) => {
    const ci = Math.round(it.lat * 500), cj = Math.round(it.lon * 500);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const r of grid.get(`${ci + di},${cj + dj}`) || []) {
        if ((r.kind || null) === (kind || null) && dist(r, it) <= 30) return r;
      }
    }
    return null;
  };
  let added = 0;
  for (const it of items) {
    const kind = HAZARDS[it.kind] ? it.kind : null;
    const lat = +it.lat, lon = +it.lon;
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const dup = near({ lat, lon }, kind);
    if (dup) {
      if (it.limit && !dup.limit) dup.limit = it.limit; // completa o limite que faltava
      continue;
    }
    const r = {
      ...(kind ? { kind } : {}),
      id: uid(), lat, lon, limit: it.limit ?? null, heading: it.heading ?? null,
      source: it.source || 'importado', osmId: it.osmId || null, note: it.note || '',
      confirmations: it.confirmations ?? 0, denials: it.denials ?? 0,
      created: it.created || Date.now(), lastSeen: it.lastSeen || null,
    };
    list.push(r);
    put(r);
    added++;
  }
  await persist();
  return added;
}
