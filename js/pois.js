// Busca no OpenStreetMap (Overpass) postos, restaurantes, paradas, hotéis e
// radares ao longo da rota. Tudo é salvo junto com a viagem para uso offline.
import { simplify, locate, pointAt, projSeg, bearing, angleDiff } from './geo.js';
import { fetchT } from './routing.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const CATEGORIES = {
  fuel: { icon: '⛽', label: 'Posto' },
  food: { icon: '🍽️', label: 'Restaurante' },
  rest: { icon: '🅿️', label: 'Parada / descanso' },
  lodging: { icon: '🛏️', label: 'Hotel / motel' },
  toll: { icon: '💰', label: 'Pedágio' },
};

function classify(tags) {
  if (tags.highway === 'speed_camera' || tags.enforcement === 'maxspeed') return 'radar';
  if (tags.barrier === 'toll_booth' || tags.highway === 'toll_gantry') return 'toll';
  if (tags.amenity === 'fuel') return 'fuel';
  if (['restaurant', 'fast_food', 'cafe', 'food_court'].includes(tags.amenity)) return 'food';
  if (tags.highway === 'services' || tags.highway === 'rest_area' || tags.amenity === 'truck_stop') return 'rest';
  if (['motel', 'hotel', 'guest_house'].includes(tags.tourism)) return 'lodging';
  return null;
}

// Consulta leve: pergunta aos servidores ao mesmo tempo e usa o primeiro que
// responder (radares e pedágios de um trecho; resposta pequena).
async function overpassFast(query, ms = 30000) {
  const ask = async (url) => {
    const res = await fetchT(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, ms);
    if (!res.ok) throw new Error('Overpass ' + res.status);
    return (await res.json()).elements || [];
  };
  try { return await Promise.any(OVERPASS.map(ask)); } catch (e) { throw e.errors?.[0] || e; }
}

// Roda tarefas com no máximo n ao mesmo tempo.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// Divide a rota em trechos de ~len metros (para viagens longas, ex.: até o Chuí).
function pieces(line, len) {
  // Adensa retas longas (a cada ~5 km) para nenhum trecho virar uma caixa gigante.
  const P = [line.pts[0]];
  for (let i = 1; i < line.pts.length; i++) {
    const a = line.pts[i - 1], b = line.pts[i];
    const seg = line.cum[i] - line.cum[i - 1];
    const n = Math.ceil(seg / 5000);
    for (let k = 1; k <= n; k++) P.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
  }
  const out = [];
  let cur = [P[0]], acc = 0;
  for (let i = 1; i < P.length; i++) {
    acc += Math.hypot((P[i].lat - P[i - 1].lat) * 111320, (P[i].lon - P[i - 1].lon) * 111320 * Math.cos((P[i].lat * Math.PI) / 180));
    cur.push(P[i]);
    if (acc >= len || i === P.length - 1) { out.push(cur); cur = [P[i]]; acc = 0; }
  }
  return out;
}

// Radares e pedágios primeiro: consulta por "caixa" de cada trecho de ~60 km
// (bem mais leve que buscar em volta de cada ponto), 3 trechos por vez, com
// nova tentativa. onPartial recebe o que já chegou.
async function fetchRadarsTolls(line, onProgress = () => {}, onPartial = null) {
  const parts = pieces(line, 60000);
  const radars = new Map(), tolls = new Map();
  let ok = 0, done = 0;
  await pool(parts, 3, async (pts) => {
    const pad = 0.006;
    const s = Math.min(...pts.map((p) => p.lat)) - pad, n = Math.max(...pts.map((p) => p.lat)) + pad;
    const w = Math.min(...pts.map((p) => p.lon)) - pad, e = Math.max(...pts.map((p) => p.lon)) + pad;
    const bb = `(${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)})`;
    const q = `[out:json][timeout:25];(node["highway"="speed_camera"]${bb};nwr["barrier"="toll_booth"]${bb};node["highway"="toll_gantry"]${bb};);out center tags;`;
    let els = null;
    for (let t = 0; t < 2 && !els; t++) { try { els = await overpassFast(q); } catch { /* tenta de novo */ } }
    done++;
    onProgress(done / parts.length);
    if (!els) return;
    ok++;
    for (const el of els) {
      const key = el.type + el.id;
      const tags = el.tags || {};
      if (classify(tags) === 'radar') radars.set(key, el); else tolls.set(key, el);
    }
    onPartial?.({ radars: [...radars.values()], tolls: [...tolls.values()] });
  });
  if (!ok) throw new Error('não consegui falar com o servidor do mapa');
  return { radarEls: [...radars.values()], tollEls: [...tolls.values()], complete: ok === parts.length };
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetchT(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, 100000); // trechos longos de estrada podem levar ~1 min
      if (res.ok) return (await res.json()).elements || [];
      lastErr = new Error('Overpass ' + res.status);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function buildQuery(coordStr, radius) {
  const a = `(around:${radius},${coordStr})`;
  return `[out:json][timeout:60];
(
  nwr${a}["amenity"="fuel"];
  nwr${a}["amenity"~"^(restaurant|fast_food|cafe|food_court|truck_stop)$"];
  nwr${a}["highway"~"^(services|rest_area)$"];
  nwr${a}["tourism"~"^(motel|hotel|guest_house)$"];
);
out center tags;`;
}

function toRadar(el) {
  const tags = el.tags || {};
  return {
    lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon,
    limit: parseInt(tags.maxspeed, 10) || null,
    heading: parseFloat(tags.direction) >= 0 ? parseFloat(tags.direction) : null,
    osmId: el.type + el.id,
  };
}

function toPoi(el, line, radius) {
  const tags = el.tags || {};
  const cat = classify(tags);
  if (!cat || cat === 'radar') return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  const loc = locate(line, { lat, lon }, 0, line.pts.length - 1, cat === 'toll' ? 60 : radius + 100);
  if (!loc) return null;
  return {
    cat, lat, lon,
    along: Math.round(loc.along),
    offset: Math.round(loc.offset),
    name: tags.name || tags.brand || tags.operator || CATEGORIES[cat].label,
    brand: tags.brand || '',
    h24: tags.opening_hours === '24/7',
    hours: tags.opening_hours || '',
    phone: tags.phone || tags['contact:phone'] || '',
    ...(cat === 'toll' ? { price: parsePrice(tags['charge:motorcar'] || tags.charge), freeFlow: tags.highway === 'toll_gantry', pay: payFrom(tags) } : {}),
  };
}

// Formas de pagamento do pedágio, quando o mapa informa (payment:cash, :pix…).
function payFrom(tags) {
  const v = (k) => tags['payment:' + k];
  const pay = {};
  if (v('cash')) pay.cash = v('cash') === 'yes';
  const cards = ['credit_cards', 'debit_cards', 'cards', 'visa', 'mastercard'].map(v).filter(Boolean);
  if (cards.length) pay.card = cards.includes('yes');
  if (v('pix')) pay.pix = v('pix') === 'yes';
  const tagsEl = ['sem_parar', 'conectcar', 'veloe', 'move_mais', 'taggy', 'electronic_toll_collection'].map(v).filter(Boolean);
  if (tagsEl.length) pay.tag = tagsEl.includes('yes');
  return Object.keys(pay).length ? pay : null;
}

// line: {pts,cum,length}. onProgress(fração). onPartial({radars, pois}):
// radares e pedágios chegam antes (em segundos), os postos depois.
// Um trecho que falhar não derruba o resto (complete = false).
export async function fetchAlongRoute(line, radius = 400, onProgress = () => {}, onPartial = null) {
  // 1) radares e pedágios (rápido, a viagem inteira)
  let rt = null, rtErr = null;
  try {
    rt = await fetchRadarsTolls(line, (f) => onProgress(f * 0.35), onPartial && ((p) => onPartial({
      radars: p.radars.map(toRadar).filter((r) => r.lat != null),
      pois: p.tolls.map((el) => toPoi(el, line, radius)).filter(Boolean).sort((a, b) => a.along - b.along),
    })));
  } catch (e) { rtErr = e; }

  // 2) postos, restaurantes, paradas e hotéis (mais pesado)
  const simple = simplify(line.pts, 25);
  const CHUNK = 120;
  const chunks = [];
  for (let i = 0; i < simple.length - 1; i += CHUNK - 1) chunks.push(simple.slice(i, i + CHUNK));
  const seen = new Map();
  let okChunks = 0, done = 0;
  await pool(chunks, 2, async (ch) => {
    const coordStr = ch.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
    let els = null;
    for (let t = 0; t < 2 && !els; t++) { try { els = await overpass(buildQuery(coordStr, radius)); } catch { /* tenta de novo */ } }
    done++;
    onProgress(0.35 + (done / chunks.length) * 0.65);
    if (!els) return;
    okChunks++;
    for (const el of els) if (!seen.has(el.type + el.id)) seen.set(el.type + el.id, el);
  });
  if (!rt && !okChunks) throw rtErr || new Error('não consegui baixar os dados da estrada');

  const pois = [];
  for (const el of [...seen.values(), ...(rt?.tollEls || [])]) {
    const p = toPoi(el, line, radius);
    if (p) pois.push(p);
  }
  pois.sort((a, b) => a.along - b.along);
  const radars = (rt?.radarEls || []).map(toRadar).filter((r) => r.lat != null);
  return { pois, radars, complete: !!rt?.complete && okChunks === chunks.length };
}

// Trechos longos sem posto (inclui saída e chegada como extremos).
export function fuelGaps(pois, length) {
  const marks = [0, ...pois.filter((p) => p.cat === 'fuel').map((p) => p.along), length];
  const gaps = [];
  for (let i = 1; i < marks.length; i++) gaps.push({ from: marks[i - 1], to: marks[i], len: marks[i] - marks[i - 1] });
  return gaps.sort((a, b) => b.len - a.len);
}

function parsePrice(v) {
  const m = String(v || '').match(/(\d+)[.,](\d{2})/);
  return m ? parseFloat(`${m[1]}.${m[2]}`) : null;
}

// Uma praça costuma estar mapeada nos dois sentidos/várias cabines: agrupa
// tudo que estiver a menos de 600 m ao longo da rota.
export function tollPlazas(pois) {
  const plazas = [];
  for (const p of pois.filter((x) => x.cat === 'toll').sort((a, b) => a.along - b.along)) {
    const last = plazas[plazas.length - 1];
    if (last && p.along - last.along < 600) {
      if (!last.price && p.price) last.price = p.price;
      if (last.name === 'Pedágio' && p.name !== 'Pedágio') last.name = p.name;
      continue;
    }
    plazas.push({ ...p });
  }
  return plazas;
}

// Estimativa: usa o preço do mapa quando existe, senão a tarifa média informada.
export function tollEstimate(pois, avgPrice) {
  const plazas = tollPlazas(pois);
  let total = 0, known = 0;
  for (const p of plazas) {
    if (p.price) { total += p.price; known++; } else total += avgPrice;
  }
  return { plazas, total, known };
}

const LODGING_RX = '^(hotel|motel|guest_house|hostel|apartment|chalet)$';

// Hospedagens perto de um ponto (pernoite), mais próximas primeiro.
export async function lodgingNear(pt, radius = 6000) {
  const els = await overpass(`[out:json][timeout:40];
nwr(around:${radius},${pt.lat},${pt.lon})["tourism"~"${LODGING_RX}"];
out center tags 60;`);
  const KIND = { hotel: 'Hotel', motel: 'Motel', guest_house: 'Pousada', hostel: 'Hostel', apartment: 'Apartamento', chalet: 'Chalé' };
  return els.map((el) => {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    return {
      lat, lon,
      name: t.name || KIND[t.tourism] || 'Hospedagem',
      kind: KIND[t.tourism] || 'Hospedagem',
      stars: parseInt(t.stars, 10) || null,
      phone: t.phone || t['contact:phone'] || '',
      site: t.website || t['contact:website'] || '',
      d: Math.hypot((lat - pt.lat) * 111000, (lon - pt.lon) * 111000 * Math.cos(pt.lat * Math.PI / 180)),
    };
  }).filter((x) => x.lat != null && x.name !== 'Hospedagem').sort((a, b) => a.d - b.d).slice(0, 8);
}

// Radares do OpenStreetMap num raio ao redor de um ponto (ex.: sua cidade).
export async function radarsNear(pt, radius = 40000) {
  const els = await overpass(`[out:json][timeout:60];
node(around:${radius},${pt.lat},${pt.lon})["highway"="speed_camera"];
out;`);
  return els.map((el) => ({
    lat: el.lat, lon: el.lon,
    limit: parseInt(el.tags?.maxspeed, 10) || null,
    heading: parseFloat(el.tags?.direction) >= 0 ? parseFloat(el.tags.direction) : null,
    osmId: 'node' + el.id,
  }));
}

// ---------- Limite de velocidade da via ----------
// Baixa as vias da rota que têm "maxspeed" no OpenStreetMap e associa cada
// trecho da rota (a cada 100 m) à via mais próxima no mesmo sentido.
// Resultado compacto: [[deMetro, ateMetro, limite], ...].
function parseLimit(v) {
  const m = String(v || '').match(/^(\d{2,3})(\s*km\/h)?$/);
  return m ? parseInt(m[1], 10) : null;
}

export async function fetchSpeedLimits(line, onProgress = () => {}) {
  const simple = simplify(line.pts, 15);
  const CHUNK = 120;
  const ways = [];
  const seen = new Set();
  const chunks = [];
  for (let i = 0; i < simple.length - 1; i += CHUNK - 1) chunks.push(simple.slice(i, i + CHUNK));
  for (let c = 0; c < chunks.length; c++) {
    const coordStr = chunks[c].map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
    const els = await overpass(`[out:json][timeout:90];
way(around:20,${coordStr})["highway"]["maxspeed"];
out tags geom;`);
    for (const el of els) {
      if (seen.has(el.id) || !el.geometry) continue;
      seen.add(el.id);
      const limit = parseLimit(el.tags.maxspeed);
      if (limit) ways.push({ limit, pts: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })) });
    }
    onProgress((c + 1) / chunks.length);
  }
  return matchLimits(line, ways);
}

export function matchLimits(line, ways) {
  // Índice espacial simples: células de ~500 m.
  const CELL = 0.005;
  const grid = new Map();
  const key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const addCell = (k, seg) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(seg); };
  for (const w of ways) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      const seg = { a, b, limit: w.limit, brg: bearing(a, b) };
      const n = Math.max(1, Math.ceil(Math.hypot(b.lat - a.lat, b.lon - a.lon) / (CELL / 2)));
      const cells = new Set();
      for (let j = 0; j <= n; j++) cells.add(key(a.lat + (b.lat - a.lat) * j / n, a.lon + (b.lon - a.lon) * j / n));
      for (const k of cells) addCell(k, seg);
    }
  }
  const STEP = 100;
  const out = [];
  for (let along = 0; along < line.length; along += STEP) {
    const p = pointAt(line, along);
    const cy = Math.floor(p.lat / CELL), cx = Math.floor(p.lon / CELL);
    let best = null, bd = 20;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const seg of grid.get(`${cy + dy}:${cx + dx}`) || []) {
          const diff = angleDiff(seg.brg, p.heading);
          if (diff > 35 && diff < 145) continue; // via cruzando (viaduto, cruzamento)
          const d = projSeg(p, seg.a, seg.b).d;
          if (d < bd) { bd = d; best = seg; }
        }
      }
    }
    const lim = best ? best.limit : null;
    const last = out[out.length - 1];
    if (last && last[2] === lim && last[1] === along) last[1] = along + STEP;
    else if (lim) out.push([along, along + STEP, lim]);
  }
  return out;
}

export function limitAt(limits, along) {
  let lo = 0, hi = (limits?.length || 0) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, v] = limits[mid];
    if (along < a) hi = mid - 1;
    else if (along >= b) lo = mid + 1;
    else return v;
  }
  return null;
}
