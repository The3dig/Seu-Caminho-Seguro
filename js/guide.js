// "O que fazer na cidade": pontos turísticos perto do destino (OpenStreetMap),
// com uma frase da Wikipédia quando existe, em ordem de visita a pé e com
// horário previsto. Fica salvo junto com a viagem (funciona sem internet lá).
import { overpassQuery } from './pois.js';
import { fetchT } from './routing.js';

const TYPES = {
  museum: { icon: '🏛️', label: 'Museu', min: 75, pts: 3 },
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
const norm2 = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => !['museu', 'palacio', 'casa', 'igreja', 'catedral', 'parque'].includes(w));
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
    const score = TYPES[type].pts + (t.wikidata ? 4 : 0) + (t.wikipedia ? 4 : 0) + (t.tourism ? 1 : 0) + (t.opening_hours ? 1 : 0);
    const it = { name: t.name, type, lat, lon, score, hours: t.opening_hours || '', wiki: t.wikipedia || '', site: t.website || t['contact:website'] || '', d: dist(pt, { lat, lon }) };
    const k = norm(t.name);
    const prev = seen.get(k);
    if (!prev || prev.score < it.score) seen.set(k, it);
  }
  // Os mais importantes (e não muito longe). Tira repetidos do mesmo lugar
  // (ex.: "Museu Imperial" e "Palácio Imperial", que ficam no mesmo prédio).
  // Palavras que aparecem em muitos nomes (ex.: o nome da cidade) não contam.
  const freq = new Map();
  for (const x of seen.values()) for (const w of new Set(norm2(x.name))) freq.set(w, (freq.get(w) || 0) + 1);
  const words = (n) => new Set(norm2(n).filter((w) => w.length >= 5 && freq.get(w) < 3));
  const ranked = [...seen.values()].filter((x) => x.score >= 3).sort((x, y) => y.score - x.score + (x.d - y.d) / 3000);
  const kept = [];
  for (const it of ranked) {
    const w = words(it.name);
    if (kept.some((k) => dist(k, it) < 150 && [...words(k.name)].some((x) => w.has(x)))) continue;
    kept.push(it);
    if (kept.length >= 10) break;
  }
  // Escolhe pelos mais importantes até encher o dia (umas 18h, no máx. 6).
  // Fechado no dia ou sem tempo: vai para "também vale" (outro dia).
  const start = new Date(arrive).getTime() + 15 * 60000; // chega e estaciona
  const cutoff = new Date(start); cutoff.setHours(18, 0, 0, 0);
  const budget = Math.max(cutoff.getTime() - start, 60 * 60000);
  const pick = [], more = [];
  let used = 0;
  for (const it of kept) { // já em ordem de importância
    it.min = TYPES[it.type].min;
    if (closedOn(it.hours, start)) { it.closed = true; more.push(it); continue; }
    const need = (it.min + 8) * 60000; // visita + caminhada média
    if (pick.length >= 6 || used + need > budget) { more.push(it); continue; }
    pick.push(it); used += need;
  }
  // Ordem de caminhada (o mais perto de onde você está, um por vez) e horários.
  const items = [];
  let cur = pt, clock = start;
  while (pick.length) {
    let bi = 0;
    for (let i = 1; i < pick.length; i++) if (dist(cur, pick[i]) < dist(cur, pick[bi])) bi = i;
    const it = pick.splice(bi, 1)[0];
    it.walk = Math.round(dist(cur, it) * 1.3); // ruas não são retas
    it.at = clock + (it.walk / 1.25) * 1000; // ~4,5 km/h
    clock = it.at + it.min * 60000;
    items.push(it);
    cur = it;
  }
  await Promise.all(items.map(async (it) => { it.about = await wikiLine(it.wiki); }));
  return { items, more, end: clock };
}

export const typeInfo = (type) => TYPES[type] || TYPES.building;

// ---------- Onde comer (opcional) ----------
const UF = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
const FOOD_RX = /(culin[aá]ri|gastronom|pratos? (t[ií]pic|famos|tradicion)|comidas? t[ií]pic|iguaria|especialidades? (local|da cidade|culin|gastron)|famos[ao]s? (pel[ao]s?|por) (seu|sua|seus|suas)? ?(truta|queijo|doce|cerveja|chocolate|vinho|pastel|past[eé]is|caf[eé]|linguiça|pinh))/i;

// Comida típica: frases da Wikipédia da cidade que falam de culinária.
// city = "Petrópolis/RJ". Sem achar, devolve [] (o app diz que não achou).
export async function typicalFood(city) {
  const [name, uf] = String(city || '').split('/');
  if (!name) return [];
  const q = `${name} ${UF[uf] || ''} município`.trim();
  try {
    const res = await fetchT(`https://pt.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(q)}&prop=extracts&explaintext=1&exlimit=1`, {}, 10000);
    if (!res.ok) return [];
    const page = Object.values((await res.json()).query?.pages || {})[0];
    if (!page || !norm(page.title).startsWith(norm(name))) return [];
    const sentences = (page.extract || '').replace(/\n+/g, ' ').split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/);
    // Frase que só cita a culinária de passagem (festa, evento) fica para o fim;
    // frase que começa sem sujeito ("É a festa…") leva a anterior junto.
    const party = /\b(festa|festival|evento|feira|exposi[cç][aã]o)\b/i;
    const hits = [];
    sentences.forEach((x, i) => {
      if (!FOOD_RX.test(x) || x.length > 400) return;
      const full = /^(É|Era|Foi|São|Tem|Possui|Inclui|Conta)(?=\s)/.test(x) && sentences[i - 1] ? `${sentences[i - 1]} ${x}` : x;
      hits.push({ txt: full.replace(/\s*\[\d+\]/g, '').trim(), party: party.test(full) });
    });
    const good = hits.filter((h) => !h.party);
    return (good.length ? good : hits.slice(0, 1).map((h) => ({ ...h, txt: '🎉 ' + h.txt }))).slice(0, 2).map((h) => h.txt);
  } catch { return []; }
}

const CUISINE = { italian: '🍝 italiana', pizza: '🍕 pizzaria', japanese: '🍣 japonesa', sushi: '🍣 japonesa', brazilian: '🇧🇷 brasileira', regional: '🍲 regional', steak_house: '🥩 churrascaria', barbecue: '🥩 churrascaria', german: '🥨 alemã', portuguese: '🐟 portuguesa', french: '🥐 francesa', seafood: '🦐 frutos do mar', fish: '🐟 peixes', arab: '🧆 árabe', lebanese: '🧆 árabe', chinese: '🥢 chinesa', mexican: '🌮 mexicana', burger: '🍔 hambúrguer', coffee_shop: '☕ café', ice_cream: '🍦 sorvete', cake: '🍰 doces', vegetarian: '🥗 vegetariana', mineira: '🍲 mineira', trout: '🐟 truta' };
const KIND = { restaurant: 'Restaurante', cafe: 'Café', bar: 'Bar', pub: 'Bar', biergarten: 'Cervejaria', ice_cream: 'Sorveteria' };
export const cuisinePt = (c) => String(c || '').split(';').map((x) => CUISINE[x.trim()] || '').filter(Boolean).slice(0, 2).join(' · ');

// Até 10 lugares para comer perto do destino, os mais "conhecidos" do mapa
// primeiro (com página na Wikipédia, site, horário…). Redes ficam de fora.
export async function foodNear(pt, radius = 2500) {
  const a = `(around:${radius},${pt.lat},${pt.lon})`;
  const els = await overpassQuery(`[out:json][timeout:40];
nwr${a}["amenity"~"^(restaurant|cafe|bar|pub|biergarten|ice_cream)$"]["name"];
out center tags 500;`);
  const out = [];
  for (const el of els) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || t.brand || t['brand:wikidata']) continue; // redes (fast food)
    const d = dist(pt, { lat, lon });
    const score = (t.wikidata ? 5 : 0) + (t.wikipedia ? 3 : 0) + (t.tourism || t.historic ? 2 : 0) + (t.website || t['contact:website'] || t['contact:instagram'] ? 1 : 0)
      + (t.opening_hours ? 1 : 0) + (t.cuisine ? 1 : 0) + (t.amenity === 'restaurant' ? 1 : 0) - d / 2000;
    out.push({ name: t.name, lat, lon, d, score, kind: KIND[t.amenity] || 'Restaurante', cuisine: cuisinePt(t.cuisine), hours: t.opening_hours || '', site: t.website || t['contact:website'] || '' });
  }
  const seenN = new Set();
  return out.sort((x, y) => y.score - x.score).filter((x) => { const k = norm(x.name); if (seenN.has(k)) return false; seenN.add(k); return true; }).slice(0, 10);
}
