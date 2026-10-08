// Busca no OpenStreetMap (Overpass) postos, restaurantes, paradas, hotéis e
// radares ao longo da rota. Tudo é salvo junto com a viagem para uso offline.
import { simplify, locate } from './geo.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
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

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
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
  const cam = `(around:60,${coordStr})`;
  const toll = `(around:40,${coordStr})`;
  return `[out:json][timeout:90];
(
  nwr${a}["amenity"="fuel"];
  nwr${a}["amenity"~"^(restaurant|fast_food|cafe|food_court|truck_stop)$"];
  nwr${a}["highway"~"^(services|rest_area)$"];
  nwr${a}["tourism"~"^(motel|hotel|guest_house)$"];
  node${cam}["highway"="speed_camera"];
  nwr${toll}["barrier"="toll_booth"];
  node${toll}["highway"="toll_gantry"];
);
out center tags;`;
}

// line: {pts,cum,length}. onProgress(fração).
export async function fetchAlongRoute(line, radius = 400, onProgress = () => {}) {
  const simple = simplify(line.pts, 25);
  const CHUNK = 150;
  const chunks = [];
  for (let i = 0; i < simple.length - 1; i += CHUNK - 1) chunks.push(simple.slice(i, i + CHUNK));

  const seen = new Map();
  for (let c = 0; c < chunks.length; c++) {
    const coordStr = chunks[c].map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
    const els = await overpass(buildQuery(coordStr, radius));
    for (const el of els) {
      const key = el.type + el.id;
      if (!seen.has(key)) seen.set(key, el);
    }
    onProgress((c + 1) / chunks.length);
  }

  const pois = [];
  const radars = [];
  for (const el of seen.values()) {
    const tags = el.tags || {};
    const cat = classify(tags);
    if (!cat) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    if (cat === 'radar') {
      radars.push({
        lat, lon,
        limit: parseInt(tags.maxspeed, 10) || null,
        heading: parseFloat(tags.direction) >= 0 ? parseFloat(tags.direction) : null,
        osmId: el.type + el.id,
      });
      continue;
    }
    const loc = locate(line, { lat, lon }, 0, line.pts.length - 1, cat === 'toll' ? 60 : radius + 100);
    if (!loc) continue;
    pois.push({
      cat, lat, lon,
      along: Math.round(loc.along),
      offset: Math.round(loc.offset),
      name: tags.name || tags.brand || tags.operator || CATEGORIES[cat].label,
      brand: tags.brand || '',
      h24: tags.opening_hours === '24/7',
      hours: tags.opening_hours || '',
      phone: tags.phone || tags['contact:phone'] || '',
      ...(cat === 'toll' ? { price: parsePrice(tags['charge:motorcar'] || tags.charge), freeFlow: tags.highway === 'toll_gantry' } : {}),
    });
  }
  pois.sort((a, b) => a.along - b.along);
  return { pois, radars };
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
