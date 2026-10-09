// Busca de lugares "do jeito que a gente fala": "UPA Caraguatatuba",
// "posto Registro", "farmácia". Primeiro tenta os buscadores de endereço;
// se não acharem exatamente, separa "o quê" de "onde" e procura no mapa
// (OpenStreetMap) pelo tipo de lugar e por sinônimos, dentro da cidade.
import { geocode, fetchT, photon, parseCoords } from './routing.js';

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
// Só letras e números: "McDonald's" = "mcdonalds".
const squash = (t) => norm(t).replace(/[^a-z0-9]+/g, '');
const km = (a, b) => {
  const r = Math.PI / 180;
  return Math.hypot((b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), (b.lat - a.lat) * r) * 6371;
};

// Palavras comuns → tipo de lugar no mapa + nomes alternativos.
const KINDS = [
  { rx: /^(upa|pronto ?socorro|pronto ?atendimento|ps)$/, tags: ['amenity~"^(hospital|clinic|doctors)$"'], name: 'upa|pronto|socorro|emergencia|24' },
  { rx: /^(hospital|santa casa)$/, tags: ['amenity~"^(hospital|clinic)$"'] },
  { rx: /^(posto|posto de gasolina|gasolina|combustivel)$/, tags: ['amenity="fuel"'] },
  { rx: /^(farmacia|drogaria)$/, tags: ['amenity="pharmacy"'] },
  { rx: /^(padaria|panificadora)$/, tags: ['shop="bakery"'] },
  { rx: /^(mercado|supermercado)$/, tags: ['shop~"^(supermarket|convenience)$"'] },
  { rx: /^(restaurante|comida|almoco|lanchonete)$/, tags: ['amenity~"^(restaurant|fast_food)$"'] },
  { rx: /^(hotel|pousada|motel|hospedagem)$/, tags: ['tourism~"^(hotel|motel|guest_house|hostel)$"'] },
  { rx: /^(banco|caixa eletronico|caixa)$/, tags: ['amenity~"^(bank|atm)$"'] },
  { rx: /^(delegacia|policia)$/, tags: ['amenity="police"'] },
  { rx: /^(rodoviaria)$/, tags: ['amenity="bus_station"'] },
  { rx: /^(praia)$/, tags: ['natural="beach"'] },
  { rx: /^(shopping)$/, tags: ['shop="mall"'] },
  { rx: /^(escola|colegio)$/, tags: ['amenity="school"'] },
  { rx: /^(igreja)$/, tags: ['amenity="place_of_worship"'] },
  { rx: /^(borracharia)$/, tags: ['shop="tyres"'] },
  { rx: /^(oficina|mecanico)$/, tags: ['shop="car_repair"'] },
];

// Marcas do jeito que a gente fala/escreve → nome certo no mapa.
// osm = como procurar no nome/marca dos lugares ao seu redor.
const BRANDS = [
  { rx: /^(ma?c|mec|mek|mak) ?donn?al?ds?$|^m[eé](qu|k)i$/, name: "McDonald's", osm: 'm(a)?c ?donald' },
  { rx: /^bur?gu?er ?king$|^bk$/, name: 'Burger King', osm: 'burger ?king' },
  { rx: /^hab+ib?s?$/, name: "Habib's", osm: 'habib' },
  { rx: /^bobs$/, name: "Bob's", osm: "^bob'?s" },
  { rx: /^(kfc|kentuck)/, name: 'KFC', osm: 'kfc|kentucky' },
  { rx: /^sub ?way$/, name: 'Subway', osm: 'subway' },
  { rx: /^outback$/, name: 'Outback', osm: 'outback' },
  { rx: /^giraf+as?$/, name: 'Giraffas', osm: 'giraf+as' },
  { rx: /^spoleto$/, name: 'Spoleto', osm: 'spoleto' },
  { rx: /^starbucks?$/, name: 'Starbucks', osm: 'starbucks' },
  { rx: /^pizza ?hut$/, name: 'Pizza Hut', osm: 'pizza ?hut' },
  { rx: /^frango assado$/, name: 'Frango Assado', osm: 'frango assado' },
  { rx: /^graal$/, name: 'Graal', osm: 'graal' },
  { rx: /^(posto )?ipiranga$/, name: 'Posto Ipiranga', osm: 'ipiranga' },
  { rx: /^(posto )?shell$/, name: 'Posto Shell', osm: 'shell' },
  { rx: /^(posto )?(petrobras|br)$/, name: 'Posto Petrobras', osm: 'petrobras|^posto br' },
  { rx: /^carrefour$/, name: 'Carrefour', osm: 'carrefour' },
  { rx: /^ass?ai$/, name: 'Assaí', osm: 'assa[ií]' },
  { rx: /^atacadao$/, name: 'Atacadão', osm: 'atacad[aã]o' },
  { rx: /^drogasil$/, name: 'Drogasil', osm: 'drogasil' },
  { rx: /^(droga )?raia$/, name: 'Droga Raia', osm: 'raia' },
  { rx: /^pague ?menos$/, name: 'Pague Menos', osm: 'pague ?menos' },
];

// "mac donalds caraguatatuba" → { name: "McDonald's", rest: 'caraguatatuba' }
function findBrand(text) {
  const words = norm(text).replace(/['’`]/g, '').split(/\s+/).filter(Boolean);
  for (let k = Math.min(3, words.length); k >= 1; k--) {
    const b = BRANDS.find((x) => x.rx.test(words.slice(0, k).join(' ')));
    if (b) return { ...b, rest: words.slice(k).join(' ') };
  }
  return null;
}

// Centro de uma cidade/bairro pelo nome (ex.: "caraguatatuba").
async function placeCenter(name) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&featureType=settlement&accept-language=pt-BR&q=${encodeURIComponent(name)}`;
  const res = await fetchT(url, {}, 12000);
  if (!res.ok) return null;
  const d = (await res.json())[0];
  return d ? { lat: +d.lat, lon: +d.lon, name: d.display_name.split(',')[0] } : null;
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// fast: pergunta aos 3 servidores ao mesmo tempo e usa o primeiro que responder
// (nas sugestões, enquanto digita); senão tenta um de cada vez.
async function overpassAround(filters, center, radius, ms = 20000, fast = false) {
  const q = `[out:json][timeout:20];(${filters.map((f) => `nwr(around:${radius},${center.lat},${center.lon})${f};`).join('')});out center tags 40;`;
  const ask = async (url) => {
    const res = await fetchT(url, {
      method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, ms);
    if (!res.ok) throw new Error('overpass ' + res.status);
    return (await res.json()).elements || [];
  };
  if (fast) {
    try { return await Promise.any(OVERPASS.map(ask)); } catch (e) { throw e.errors?.[0] || e; }
  }
  let err;
  for (const url of OVERPASS) {
    try { return await ask(url); } catch (e) { err = e; }
  }
  throw err;
}

// Nominatim só dentro de um quadrado ao seu redor (~35 km): acha lojas pelo nome.
async function nominatimNear(text, near, ms = 9000) {
  const d = 0.32;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&countrycodes=br&bounded=1&accept-language=pt-BR&viewbox=${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}&q=${encodeURIComponent(text)}`;
  const res = await fetchT(url, {}, ms);
  if (!res.ok) throw new Error('nominatim ' + res.status);
  return (await res.json()).map((r) => ({ lat: +r.lat, lon: +r.lon, label: r.display_name.split(',').slice(0, 4).join(','), cls: 'poi' }));
}

// Separa "o quê" e "onde": tenta as últimas palavras como cidade.
async function splitWhatWhere(words) {
  for (let k = 1; k < words.length && k <= 3; k++) {
    const where = words.slice(k).join(' ');
    if (where.length < 3) continue;
    const c = await placeCenter(where);
    if (c) return { what: words.slice(0, k).join(' '), center: c, where: c.name };
  }
  return null;
}

export async function poiSearch(text, near, { ms = 20000 } = {}) {
  const words = norm(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const split = words.length > 1 ? await splitWhatWhere(words) : null;
  const what = split ? split.what : words.join(' ');
  const center = split?.center || near;
  if (!center) return [];
  const kind = KINDS.find((k) => k.rx.test(what));
  const esc = (s) => s.replace(/[\\"]/g, '').replace(/[.*+?^${}()|[\]]/g, '\\$&');
  const filters = [];
  if (kind) {
    for (const t of kind.tags) filters.push(kind.name ? `[${t}]["name"~"${kind.name}",i]` : `[${t}]`);
    if (kind.name) for (const t of kind.tags) filters.push(`[${t}]`); // sem o nome também
  } else {
    filters.push(`["name"~"${esc(what)}",i]`);
  }
  const els = await overpassAround(filters, center, split ? 15000 : 25000, ms);
  const seen = new Set();
  const out = [];
  for (const el of els) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || seen.has(el.type + el.id)) continue;
    seen.add(el.type + el.id);
    const name = t.name || t.brand || t.operator || (kind ? what.toUpperCase() : 'Lugar');
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
    const city = t['addr:city'] || split?.where || '';
    // 100 = tem a palavra digitada no nome ("UPA 24h"); 99 = sinônimo
    // ("Pronto Atendimento"); 98 = só o tipo (hospital sem o nome).
    const typed = new RegExp(`\\b${esc(what)}\\b`, 'i').test(norm(name));
    const syn = kind?.name ? new RegExp(kind.name, 'i').test(norm(name)) : true;
    const score = typed ? 100 : syn ? 99 : 98;
    out.push({ lat, lon, label: [name, street, city].filter(Boolean).join(', '), full: true, score, km: near ? km(near, { lat, lon }) : null, d0: km(center, { lat, lon }) });
  }
  // Mesma relevância: o mais perto de você (se você está na cidade) ou do centro dela.
  const local = near && km(near, center) < 40;
  out.sort((a, b) => b.score - a.score || (local ? a.km - b.km : a.d0 - b.d0));
  return out.slice(0, 8);
}

export async function searchPlaces(text, near = null) {
  if (parseCoords(text)) return geocode(text, near);
  // As mesmas sugestões espertas da digitação primeiro, depois os buscadores de endereço.
  const [sug, geo] = await Promise.allSettled([suggestPlaces(text, near), geocode(text, near)]);
  const base = [];
  for (const r of sug.value || []) base.push({ ...r, full: r.rank >= 2 || !!r.fame });
  for (const r of geo.value || []) if (!base.some((m) => km(m, r) < 0.15)) base.push(r);
  if (base.some((r) => r.full)) return base.slice(0, 8);
  let extra = [];
  try {
    extra = await poiSearch(text, near);
  } catch (e) {
    if (!base.length && sug.status === 'rejected' && geo.status === 'rejected') throw geo.reason;
  }
  const merged = [...extra];
  for (const r of base) if (!merged.some((m) => km(m, r) < 0.15)) merged.push(r);
  if (!merged.length && sug.status === 'rejected' && geo.status === 'rejected') throw geo.reason;
  return merged.slice(0, 8);
}

// Sugestões enquanto digita (como no Waze):
// - lugares famosos com esse nome (a cidade de Aparecida, o Santuário) aparecem
//   mesmo longe, no topo;
// - marcas ("mac donalds", "bk", "habibs") viram o nome certo e procuramos
//   todas as lojas ao seu redor;
// - o resto: o que bate com o nome, o mais perto primeiro; ruas com o nome
//   ficam abaixo de lugares; os muito longe (>80 km) vão pro fim.
const sugCache = new Map();
const SETTLE_OR_LANDMARK = new Set(['city', 'landmark']);

function rankList(all, words, near, brand) {
  const syn = KINDS.find((k) => k.rx.test(words.join(' ')) || k.rx.test(words[0]))?.name;
  const sw = words.map(squash).filter(Boolean);
  const brandRx = brand ? new RegExp(brand.osm, 'i') : null;
  const out = [];
  for (const r of all) {
    const dup = out.find((o) => km(o, r) < 0.15);
    if (dup) { if (r.fame && !dup.fame) dup.fame = r.fame; continue; }
    const name = r.label.split(',')[0];
    const sname = squash(name);
    const sfull = squash(r.label);
    r.rank = (brandRx && brandRx.test(norm(name))) || sw.every((w) => sname.includes(w)) ? 3
      : syn && new RegExp(syn).test(norm(name)) ? 2
        : sw.every((w) => sfull.includes(w)) ? 1 : 0;
    r.km = near ? km(near, r) : null;
    r.exact = sname === sw.join('');
    out.push(r);
  }
  // Famoso só se o nome bate com tudo o que foi digitado.
  for (const r of out) if (r.fame && r.rank < 3) r.fame = 0;
  const far = (r) => r.km != null && r.km > 80;
  const tier = (r) => {
    if (r.fame) return r.exact ? 11 : 10; // "Aparecida" (a cidade) antes de "Aparecida de Goiânia"
    let t = r.rank >= 2 ? 3 : r.rank;
    if (r.cls === 'street' && t === 3) t = 2; // "Rua Aparecida" abaixo dos lugares
    return t - (far(r) ? 4 : 0);
  };
  // Tendo algum que bate com o nome, some com os que não têm nada a ver.
  const list = brand || out.some((r) => r.rank > 0) ? out.filter((r) => r.rank > 0) : out;
  list.sort((a, b) => tier(b) - tier(a) || (a.km ?? 0) - (b.km ?? 0));
  return list.slice(0, 8);
}

// onUpdate(lista) é chamado a cada fonte que responde (mostra o que já chegou).
export async function suggestPlaces(text, near = null, onUpdate = () => {}) {
  const q = norm(text);
  if (q.length < 2) return [];
  const key = `${q}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ''}`;
  if (sugCache.has(key)) { onUpdate(sugCache.get(key)); return sugCache.get(key); }
  const brand = findBrand(text);
  const qtext = brand ? [brand.name, brand.rest].filter(Boolean).join(' ') : text;
  const words = norm(qtext).split(/\s+/).filter(Boolean);
  const got = [];
  let best = [];
  const push = (list) => { got.push(...list); best = rankList(got, words, near, brand); onUpdate(best); };
  // Os primeiros do Brasil inteiro que sejam cidade ou ponto famoso.
  const famous = (list) => {
    let n = 0;
    for (const r of list) if (SETTLE_OR_LANDMARK.has(r.cls) && n < 3) r.fame = ++n;
    return list;
  };
  const tasks = [];
  // 1) sua região (~50 km); 2) perto de você primeiro; 3) famosos no Brasil; 4) cidades com esse nome
  if (near) tasks.push(photon(qtext, near, { area: 0.45, ms: 7000 }).then(push));
  tasks.push(photon(qtext, near, { ms: 9000 }).then(push));
  if (!brand) {
    tasks.push(photon(qtext, near, { global: true, limit: 6, ms: 9000 }).then((l) => push(famous(l))));
    tasks.push(photon(qtext, near, { global: true, places: true, limit: 3, ms: 9000 }).then((l) => push(famous(l))));
  }
  // Marca: todas as lojas dela ao seu redor (o buscador de endereço acha só algumas).
  if (brand && near) {
    tasks.push(nominatimNear(brand.name, near).then(push));
    tasks.push(overpassAround([`["name"~"${brand.osm}",i]`, `["brand"~"${brand.osm}",i]`], near, 30000, 15000, true).then((els) => push(els.map((el) => {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
      return { lat, lon, label: [t.name || brand.name, street, t['addr:suburb'], t['addr:city']].filter(Boolean).join(', '), cls: 'poi' };
    }).filter((r) => r.lat != null))));
  }
  // "upa", "posto", "farmácia"…: procura esse tipo de lugar ao seu redor
  if (!brand && near && words.length <= 2 && KINDS.some((k) => k.rx.test(words[0]))) tasks.push(poiSearch(text, near, { ms: 12000 }).then(push));
  const res = await Promise.allSettled(tasks);
  if (!got.length && res.every((r) => r.status === 'rejected')) throw res[0].reason;
  sugCache.set(key, best);
  if (sugCache.size > 100) sugCache.delete(sugCache.keys().next().value);
  return best;
}
