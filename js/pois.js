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
};

function classify(tags) {
  if (tags.highway === 'speed_camera' || tags.enforcement === 'maxspeed') return 'radar';
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
  return `[out:json][timeout:90];
(
  nwr${a}["amenity"="fuel"];
  nwr${a}["amenity"~"^(restaurant|fast_food|cafe|food_court|truck_stop)$"];
  nwr${a}["highway"~"^(services|rest_area)$"];
  nwr${a}["tourism"~"^(motel|hotel|guest_house)$"];
  node${cam}["highway"="speed_camera"];
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
    const loc = locate(line, { lat, lon }, 0, line.pts.length - 1, radius + 100);
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
