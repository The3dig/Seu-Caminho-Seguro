// Busca de lugares "do jeito que a gente fala": "UPA Caraguatatuba",
// "posto Registro", "farmácia". Primeiro tenta os buscadores de endereço;
// se não acharem exatamente, separa "o quê" de "onde" e procura no mapa
// (OpenStreetMap) pelo tipo de lugar e por sinônimos, dentro da cidade.
import { geocode, fetchT } from './routing.js';

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
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

// Centro de uma cidade/bairro pelo nome (ex.: "caraguatatuba").
async function placeCenter(name) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&featureType=settlement&accept-language=pt-BR&q=${encodeURIComponent(name)}`;
  const res = await fetchT(url, {}, 12000);
  if (!res.ok) return null;
  const d = (await res.json())[0];
  return d ? { lat: +d.lat, lon: +d.lon, name: d.display_name.split(',')[0] } : null;
}

async function overpassAround(filters, center, radius) {
  const q = `[out:json][timeout:25];(${filters.map((f) => `nwr(around:${radius},${center.lat},${center.lon})${f};`).join('')});out center tags 40;`;
  const res = await fetchT('https://overpass-api.de/api/interpreter', {
    method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, 30000);
  if (!res.ok) throw new Error('overpass ' + res.status);
  return (await res.json()).elements || [];
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

async function poiSearch(text, near) {
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
  const els = await overpassAround(filters, center, split ? 15000 : 25000);
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
  let base = [];
  let baseErr = null;
  try {
    base = await geocode(text, near);
  } catch (e) {
    baseErr = e;
  }
  if (base.some((r) => r.full)) return base;
  let extra = [];
  try {
    extra = await poiSearch(text, near);
  } catch (e) {
    if (!base.length && baseErr) throw baseErr;
  }
  const merged = [...extra];
  for (const r of base) if (!merged.some((m) => km(m, r) < 0.15)) merged.push(r);
  if (!merged.length && baseErr) throw baseErr;
  return merged.slice(0, 8);
}
