// Busca de endereços (Nominatim/OSM) e cálculo de rota (OSRM).
// A rota é calculada UMA vez, antes da viagem, e nunca é recalculada.
import { makeLine, locate, simplify } from './geo.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
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

export async function geocode(text) {
  const c = parseCoords(text);
  if (c) return [c];
  const url = `${NOMINATIM}?format=jsonv2&limit=5&countrycodes=br&accept-language=pt-BR&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Falha na busca de endereço (' + res.status + ')');
  const data = await res.json();
  return data.map((d) => ({ lat: +d.lat, lon: +d.lon, label: d.display_name }));
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
      res = await fetch(OSRM_FOOT + qs);
      if (!res.ok) res = null;
    } catch {
      res = null; // cai para a rota de carro
    }
  }
  if (!res) res = await fetch(OSRM + qs);
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

// Nome da cidade num ponto (para sugerir onde dormir/parar).
export async function cityAt(lat, lon) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${lat}&lon=${lon}`);
    const d = await res.json();
    const a = d.address || {};
    const city = a.city || a.town || a.village || a.municipality || a.county || '';
    const uf = (a['ISO3166-2-lvl4'] || '').replace('BR-', '') || a.state || '';
    return city ? `${city}${uf ? '/' + uf : ''}` : (d.display_name || '').split(',')[0];
  } catch {
    return '';
  }
}
