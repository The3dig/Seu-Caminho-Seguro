// "O que fazer na cidade": pontos turísticos perto do destino (OpenStreetMap),
// com uma frase da Wikipédia quando existe, em ordem de visita a pé e com
// horário previsto. Fica salvo junto com a viagem (funciona sem internet lá).
import { overpassQuery } from './pois.js';
import { fetchT } from './routing.js';

const TYPES = {
  museum: { icon: '🏛️', label: 'Museu', min: 90, pts: 3 },
  palace: { icon: '🏰', label: 'Palácio', min: 60, pts: 3 },
  castle: { icon: '🏰', label: 'Castelo', min: 60, pts: 3 },
  gallery: { icon: '🖼️', label: 'Galeria', min: 45, pts: 2 },
  zoo: { icon: '🦁', label: 'Zoológico', min: 150, pts: 2 },
  theme_park: { icon: '🎢', label: 'Parque temático', min: 180, pts: 2 },
  attraction: { icon: '⭐', label: 'Atração', min: 45, pts: 2 },
  viewpoint: { icon: '🌄', label: 'Mirante', min: 20, pts: 2 },
  church: { icon: '⛪', label: 'Igreja', min: 25, pts: 1 },
  park: { icon: '🌳', label: 'Parque / jardim', min: 40, pts: 1 },
  monument: { icon: '🗿', label: 'Monumento', min: 10, pts: 1 },
  building: { icon: '🏛️', label: 'Prédio histórico', min: 15, pts: 0 },
};

function typeOf(t) {
  if (t.tourism === 'museum') return 'museum';
  if (t.historic === 'palace' || t.historic === 'manor' || /^pal[aá]cio/i.test(t.name || '')) return 'palace';
  if (t.historic === 'castle' || t.historic === 'fort') return 'castle';
  if (t.tourism === 'gallery') return 'gallery';
  if (t.tourism === 'zoo') return 'zoo';
  if (t.tourism === 'theme_park') return 'theme_park';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.amenity === 'place_of_worship' || t.historic === 'church' || t.building === 'cathedral' || t.building === 'church') return 'church';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.historic === 'monument' || t.historic === 'memorial') return 'monument';
  if (t.tourism === 'attraction') return 'attraction';
  return 'building';
}

const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Horário do OSM em português (Mo-Fr 09:00-17:00 → seg-sex 09:00-17:00).
const DAYS = { Mo: 'seg', Tu: 'ter', We: 'qua', Th: 'qui', Fr: 'sex', Sa: 'sáb', Su: 'dom', PH: 'feriado' };
export const hoursPt = (h) => String(h || '').replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => DAYS[d]).replace(/\boff\b/g, 'fechado').replace(/;\s*/g, ' · ');

// Fechado no dia da visita? Entende regras simples do OSM ("Mo off",
// "Tu-Su 10:00-17:00" = fechado segunda). Na dúvida, diz que não.
const ORDER = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const inRange = (d, a, b) => { const i = ORDER.indexOf(d), x = ORDER.indexOf(a), y = ORDER.indexOf(b ?? a); return x <= y ? i >= x && i <= y : i >= x || i <= y; };
export function closedOn(hours, date) {
  const h = String(hours || '');
  if (!h || /24\/7/.test(h)) return false;
  const d = ORDER[new Date(date).getDay()];
  const rules = h.split(';').map((r) => r.trim()).filter(Boolean);
  let open = null;
  for (const r of rules) {
    const m = r.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(.+)$/);
    if (!m) return false; // regra que não entendo (feriado, mês…): não arrisca
    const hit = m[1].split(',').some((part) => { const [a, b] = part.split('-'); return inRange(d, a, b); });
    if (hit) open = !/^(off|closed)$/.test(m[2].trim());
  }
  return open === false || open === null;
}

async function wikiLine(tag) {
  const m = String(tag || '').match(/^([a-z]{2,3}):(.+)$/);
  if (!m || m[1] !== 'pt') return '';
  try {
    const res = await fetchT(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(m[2].replace(/ /g, '_'))}`, {}, 8000);
    if (!res.ok) return '';
    const txt = ((await res.json()).extract || '').replace(/\s*\([^)]*\)/g, '');
    const first = txt.split(/(?<=\.)\s/)[0] || '';
    return first.length > 180 ? first.slice(0, 177).replace(/\s\S*$/, '') + '…' : first;
  } catch { return ''; }
}

// pt = destino; arrive = horário de chegada (Date). Retorna { items, start }.
export async function sightsNear(pt, arrive = new Date(), radius = 4000) {
  const a = `(around:${radius},${pt.lat},${pt.lon})`;
  const els = await overpassQuery(`[out:json][timeout:40];
(
  nwr${a}["tourism"~"^(museum|attraction|viewpoint|gallery|zoo|theme_park)$"]["name"];
  nwr${a}["historic"~"^(castle|palace|manor|fort|monument|memorial|church|building)$"]["name"];
  nwr${a}["amenity"="place_of_worship"]["name"]["wikidata"];
  nwr${a}["leisure"~"^(park|garden)$"]["name"]["wikidata"];
);
out center tags 200;`);
  const seen = new Map();
  for (const el of els) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || !t.name) continue;
    const type = typeOf(t);
    const score = TYPES[type].pts + (t.wikidata ? 4 : 0) + (t.wikipedia ? 3 : 0) + (t.tourism ? 1 : 0) + (t.opening_hours ? 1 : 0);
    const it = { name: t.name, type, lat, lon, score, hours: t.opening_hours || '', wiki: t.wikipedia || '', site: t.website || t['contact:website'] || '', d: dist(pt, { lat, lon }) };
    const k = norm(t.name);
    const prev = seen.get(k);
    if (!prev || prev.score < it.score) seen.set(k, it);
  }
  // Os mais importantes (e não muito longe), depois em ordem de caminhada.
  const top = [...seen.values()].filter((x) => x.score >= 3)
    .sort((x, y) => y.score - x.score + (x.d - y.d) / 3000).slice(0, 8);
  const route = [];
  let cur = pt;
  while (top.length) {
    let bi = 0;
    for (let i = 1; i < top.length; i++) if (dist(cur, top[i]) < dist(cur, top[bi])) bi = i;
    const it = top.splice(bi, 1)[0];
    it.walk = Math.round(dist(cur, it) * 1.3); // ruas não são retas
    route.push(it);
    cur = it;
  }
  // Horário previsto: chega, estaciona (15 min) e vai visitando.
  let clock = new Date(arrive).getTime() + 15 * 60000;
  for (const it of route) {
    clock += (it.walk / 1.25) * 1000; // ~4,5 km/h
    it.at = clock;
    it.min = TYPES[it.type].min;
    clock += it.min * 60000;
  }
  await Promise.all(route.map(async (it) => { it.about = await wikiLine(it.wiki); }));
  return { items: route, end: clock };
}

export const typeInfo = (type) => TYPES[type] || TYPES.building;
