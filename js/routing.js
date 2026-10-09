// Busca de endereços (Nominatim/OSM) e cálculo de rota (OSRM).
// A rota é calculada UMA vez, antes da viagem, e nunca é recalculada.
import { makeLine, locate, simplify } from './geo.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// fetch com limite de tempo: internet fraca nunca deixa o app "calculando" pra sempre.
export async function fetchT(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('o servidor demorou demais para responder (internet fraca?). Tente de novo.');
    throw new Error('sem conexão com a internet. Tente de novo quando tiver sinal.');
  } finally {
    clearTimeout(timer);
  }
}
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
// Rota para pedestre (usada no modo teste a pé). Servidor do OpenStreetMap Alemanha.
const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';

// Aceita "lat, lon", links do Google Maps (@lat,lon / q=lat,lon / !3dlat!4dlon) ou texto.
export function parseCoords(text) {
  const t = text.trim();
  let m = t.match(/^(-?\d{1,2}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)$/);
  if (!m) m = t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (!m) m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) m = t.match(/[?&](?:q|query|ll|daddr|destination)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  if (!m) m = t.match(/ll=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i); // links do Waze
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const km = (a, b) => {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371;
};

async function nominatim(text, near) {
  // viewbox + bounded=0: prefere resultados perto de você sem excluir os longe.
  const box = near ? `&viewbox=${near.lon - 1.5},${near.lat + 1.5},${near.lon + 1.5},${near.lat - 1.5}&bounded=0` : '';
  const url = `${NOMINATIM}?format=jsonv2&limit=8&countrycodes=br&accept-language=pt-BR${box}&q=${encodeURIComponent(text)}`;
  const res = await fetchT(url, {}, 15000);
  if (!res.ok) throw new Error('Falha na busca de endereço (' + res.status + ')');
  return (await res.json()).map((d) => ({ lat: +d.lat, lon: +d.lon, label: d.display_name }));
}

// Photon (OpenStreetMap, komoot): melhor para "UPA Caraguatatuba", "posto X em Y".
// area: graus em volta de "near" para limitar a busca à sua região (0 = sem limite).
// global: sem puxar para perto de você (os mais "famosos" do Brasil primeiro);
// places: só cidades/vilas.
export async function photon(text, near, { area = 0, ms = 12000, global = false, places = false, limit = 12 } = {}) {
  const bias = near && !global ? `&lat=${near.lat}&lon=${near.lon}&location_bias_scale=0.6` : '';
  const box = global ? '&bbox=-74,-34,-34,6'
    : near && area ? `&bbox=${near.lon - area},${near.lat - area},${near.lon + area},${near.lat + area}` : '';
  const tags = places ? '&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village&osm_tag=place:municipality' : '';
  const res = await fetchT(`https://photon.komoot.io/api/?limit=${limit}${bias}${box}${tags}&q=${encodeURIComponent(text)}`, {}, ms);
  if (!res.ok) throw new Error('photon ' + res.status);
  return ((await res.json()).features || [])
    .filter((f) => !f.properties.countrycode || f.properties.countrycode === 'BR')
    .map((f) => {
      const p = f.properties;
      const street = [p.street, p.housenumber].filter(Boolean).join(', ');
      const label = [p.name, street !== p.name ? street : '', p.district || p.locality, p.city || p.county, p.state]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label, cls: placeClass(p) };
    });
}

// TomTom (base comercial, igual à dos GPS de carro): entende erros de digitação,
// marcas e lugares famosos. global = sem puxar para perto de você.
const TT_LANDMARK = /tourist|place of worship|church|cathedral|monument|museum|stadium|airport|park|beach|historic/i;
export async function tomtom(text, near, key, { ms = 8000, limit = 10, global = false } = {}) {
  const pos = near && !global ? `&lat=${near.lat}&lon=${near.lon}` : '';
  const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(text.replace(/[/?#]/g, ' '))}.json?key=${encodeURIComponent(key)}&countrySet=BR&language=pt-BR&typeahead=true&limit=${limit}${pos}`;
  const res = await fetchT(url, {}, ms);
  if (!res.ok) throw new Error('tomtom ' + res.status);
  return ((await res.json()).results || []).map((r) => {
    const a = r.address || {};
    const street = [a.streetName, a.streetNumber].filter(Boolean).join(', ');
    let name, cls;
    if (r.type === 'POI') {
      name = r.poi?.name;
      const cats = (r.poi?.categories || []).join(' ') + ' ' + (r.poi?.classifications || []).map((c) => c.code).join(' ');
      cls = TT_LANDMARK.test(cats.replace(/_/g, ' ')) ? 'landmark' : 'poi';
    } else if (r.type === 'Geography') {
      name = a.municipalitySubdivision && r.entityType === 'MunicipalitySubdivision' ? a.municipalitySubdivision : a.municipality || a.countrySubdivision || a.freeformAddress;
      cls = /^Municipality$/.test(r.entityType) ? 'city' : 'addr';
    } else if (r.type === 'Street' || r.type === 'Cross Street') {
      name = a.streetName || a.freeformAddress; cls = 'street';
    } else {
      name = street || a.freeformAddress; cls = 'addr';
    }
    const label = [name, street !== name ? street : '', a.municipalitySubdivision !== name ? a.municipalitySubdivision : '', a.municipality !== name ? a.municipality : '', a.countrySubdivision]
      .filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
    return { lat: r.position.lat, lon: r.position.lon, label: label || 'Lugar', cls, tt: true };
  }).filter((r) => r.lat != null);
}

// Que tipo de lugar é: cidade, rua, ponto turístico/igreja famoso, comércio ou endereço.
function placeClass(p) {
  const k = p.osm_key, v = p.osm_value;
  if ((k === 'place' && /^(city|town|village|municipality|hamlet)$/.test(v)) || (k === 'boundary' && /^(city|town)$/.test(p.type))) return 'city';
  if (k === 'highway' || p.type === 'street') return 'street';
  if (k === 'tourism' || k === 'historic' || (k === 'amenity' && v === 'place_of_worship') || (k === 'building' && /^(cathedral|church|basilica)$/.test(v))
    || (k === 'aeroway' && v === 'aerodrome') || (k === 'leisure' && /^(stadium|park)$/.test(v)) || k === 'natural') return 'landmark';
  if (p.name && k && k !== 'place' && k !== 'boundary') return 'poi';
  return 'addr';
}

// Busca em duas fontes e ordena: primeiro os que contêm as palavras digitadas
// (ex.: a cidade), depois os mais perto de você.
export async function geocode(text, near = null) {
  const c = parseCoords(text);
  if (c) return [c];
  const [a, b, local] = await Promise.allSettled([nominatim(text, near), photon(text, near), near ? photon(text, near, { area: 0.45, ms: 9000 }) : Promise.resolve([])]);
  // Resultados da sua região (~50 km) entram primeiro.
  if (local.status === 'fulfilled' && b.status === 'fulfilled') b.value.unshift(...local.value);
  else if (local.status === 'fulfilled') Object.assign(b, { status: 'fulfilled', value: local.value });
  if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
  const all = [...(a.value || []), ...(b.value || [])];
  // Números (da casa) não contam: o mapa quase nunca tem o número.
  const words = norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  const out = [];
  for (const r of all) {
    if (out.some((o) => km(o, r) < 0.15)) continue; // mesmo lugar nas duas fontes
    const L = norm(r.label);
    r.score = words.filter((w) => L.includes(w)).length;
    r.full = r.score === words.length; // achou todas as palavras digitadas?
    r.km = near ? km(near, r) : null;
    out.push(r);
  }
  out.sort((x, y) => y.score - x.score || (x.km ?? 0) - (y.km ?? 0));
  return out.slice(0, 8);
}

const MOD = {
  uturn: 'faça o retorno',
  'sharp right': 'acentuadamente à direita',
  right: 'à direita',
  'slight right': 'levemente à direita',
  straight: 'em frente',
  'slight left': 'levemente à esquerda',
  left: 'à esquerda',
  'sharp left': 'acentuadamente à esquerda',
};
const ARROW = {
  uturn: '⤴', 'sharp right': '↘', right: '➡', 'slight right': '↗', straight: '⬆',
  'slight left': '↖', left: '⬅', 'sharp left': '↙',
};

export function instruction(step) {
  const mod = MOD[step.modifier] || '';
  const via = step.name ? ` na ${step.name}` : '';
  switch (step.type) {
    case 'depart': return `Siga${step.name ? ' pela ' + step.name : ''}`;
    case 'arrive': return 'Você chegou ao destino';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return step.exit ? `Na rotatória, pegue a ${step.exit}ª saída${via}` : `Entre na rotatória${via}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Saia da rotatória${via}`;
    case 'merge': return `Entre ${mod}${via}`.replace(/\s+/g, ' ');
    case 'on ramp': return `Pegue o acesso ${mod}${via}`.replace(/\s+/g, ' ');
    case 'off ramp': return `Pegue a saída ${mod}${via}`.replace(/\s+/g, ' ');
    case 'fork': return `Mantenha-se ${mod}${via}`.replace(/\s+/g, ' ');
    case 'end of road': return `No fim da via, vire ${mod}${via}`.replace(/\s+/g, ' ');
    case 'continue': return `Continue ${mod}${via}`.replace(/\s+/g, ' ');
    default:
      if (step.modifier === 'uturn') return `Faça o retorno${via}`;
      return `Vire ${mod}${via}`.replace(/\s+/g, ' ');
  }
}

export function arrow(step) {
  if (step.type === 'arrive') return '🏁';
  if (/roundabout|rotary/.test(step.type)) return '⟳';
  return ARROW[step.modifier] || '⬆';
}

// Etapas sem manobra real são descartadas para não poluir os avisos.
function relevant(s) {
  if (s.type === 'new name' || s.type === 'notification') return false;
  if (s.type === 'continue' && (!s.modifier || s.modifier === 'straight')) return false;
  return true;
}

export async function route(points, { foot = false } = {}) {
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const alt = points.length === 2 ? 'true' : 'false';
  const qs = `${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alt}`;
  let res;
  if (foot) {
    try {
      res = await fetchT(OSRM_FOOT + qs, {}, 20000);
      if (!res.ok) res = null;
    } catch {
      res = null; // cai para a rota de carro
    }
  }
  if (!res) res = await fetchT(OSRM + qs, {}, 25000);
  if (!res.ok) throw new Error('Falha ao calcular rota (' + res.status + ')');
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('Rota não encontrada: ' + (data.message || data.code));
  return data.routes.map((r) => buildRoute(r));
}

function buildRoute(r) {
  const raw = r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const pts = simplify(raw, 4);
  const line = makeLine(pts);
  const steps = [];
  let hint = 0;
  for (const leg of r.legs) {
    for (const s of leg.steps) {
      const step = {
        type: s.maneuver.type,
        modifier: s.maneuver.modifier,
        exit: s.maneuver.exit,
        name: s.ref && s.name ? `${s.name} (${s.ref})` : (s.name || s.ref || ''),
        lat: s.maneuver.location[1],
        lon: s.maneuver.location[0],
      };
      if (!relevant(step)) continue;
      // Manobras vêm em ordem; busca a partir da última para ganhar velocidade.
      const loc = locate(line, step, Math.max(0, hint - 5), line.pts.length - 1, 300) ||
        locate(line, step);
      hint = loc.index;
      step.along = loc.along;
      step.text = instruction(step);
      step.arrow = arrow(step);
      steps.push(step);
    }
  }
  return {
    pts: pts.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]),
    distance: r.distance,
    duration: r.duration,
    summary: r.legs.map((l) => l.summary).filter(Boolean).join(' · '),
    legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration, summary: l.summary })),
    steps,
  };
}

// Cidade/estado de um ponto (para pernoites e para o diário de cidades).
// Lança erro se estiver sem internet — quem chama decide se tenta depois.
export async function placeAt(lat, lon) {
  const res = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${lat}&lon=${lon}`, {}, 15000);
  if (!res.ok) throw new Error('reverse ' + res.status);
  const d = await res.json();
  const a = d.address || {};
  return {
    city: a.city || a.town || a.village || a.municipality || a.county || '',
    uf: (a['ISO3166-2-lvl4'] || '').replace(/^BR-/, ''),
    state: a.state || '',
    country: a.country || '',
    countryCode: (a.country_code || '').toUpperCase(),
  };
}

export async function cityAt(lat, lon) {
  try {
    const p = await placeAt(lat, lon);
    return p.city ? `${p.city}${p.uf ? '/' + p.uf : ''}` : '';
  } catch {
    return '';
  }
}

// Endereço da rua num ponto (para mostrar "Saindo de: Rua X, Bairro").
export async function addressAt(lat, lon) {
  const res = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=pt-BR&lat=${lat}&lon=${lon}`, {}, 12000);
  if (!res.ok) throw new Error('reverse ' + res.status);
  const a = (await res.json()).address || {};
  const street = [a.road || a.pedestrian || a.footway || a.highway, a.house_number].filter(Boolean).join(', ');
  const area = a.suburb || a.neighbourhood || a.quarter || a.village || '';
  const city = a.city || a.town || a.municipality || '';
  return [street, area, city].filter(Boolean).join(' · ') || city;
}
