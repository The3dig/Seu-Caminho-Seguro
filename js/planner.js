// Planejador de viagem: divide o trajeto em dias, sugere pausas (postos,
// restaurantes, áreas de descanso), pernoites e estima pedágio e combustível.
import { tollEstimate } from './pois.js';

export const DEFAULT_PREFS = {
  maxDriveH: 8, // horas dirigindo por dia
  breakEveryMin: 120, // pausa a cada
  breakMin: 20, // duração de cada pausa
  mealMin: 50, // duração de almoço/jantar
  nextDayHour: 8, // horário de saída nos dias seguintes
  kmPerL: 11,
  fuelPrice: 6.29,
  tollAvg: 12,
};

const KM = 1000;

// Momento do dia → tipo de refeição sugerida na pausa.
function mealOf(date) {
  const m = date.getHours() * 60 + date.getMinutes();
  if (m >= 11 * 60 + 15 && m <= 14 * 60) return 'almoço';
  if (m >= 18 * 60 + 30 && m <= 21 * 60 + 30) return 'jantar';
  return null;
}

// Melhor lugar para parar perto de `target` (metros ao longo da rota).
// Prefere áreas de serviço e postos 24h com comida por perto; aceita
// antecipar a pausa até ~30 km para não passar do limite de cansaço.
export function bestStop(pois, target, { from = 0, meal = null } = {}) {
  const near = (a, cat, max) => pois.some((p) => p.cat === cat && Math.abs(p.along - a) < max);
  let best = null;
  for (const p of pois) {
    if (!['fuel', 'food', 'rest'].includes(p.cat)) continue;
    if (p.along < Math.max(from + 20 * KM, target - 35 * KM) || p.along > target + 8 * KM) continue;
    let score = 0;
    if (p.cat === 'rest') score += 4;
    if (p.cat === 'fuel') score += 3;
    if (p.cat === 'food') score += meal ? 4 : 1;
    if (p.h24) score += 2;
    if (p.cat === 'fuel' && near(p.along, 'food', 1500)) score += 3; // posto com restaurante
    if (p.cat === 'food' && near(p.along, 'fuel', 1500)) score += 2;
    if (p.offset > 250) score -= 1; // longe da pista
    score -= Math.abs(p.along - target) / (12 * KM); // perto do horário ideal
    if (!best || score > best.score) best = { ...p, score };
  }
  if (!best) return null;
  const food = best.cat === 'food' ? null : pois.find((p) => p.cat === 'food' && Math.abs(p.along - best.along) < 1500) || null;
  return { poi: best, food };
}

// trip: { distance, duration, legs, pois }. stops: paradas intermediárias na
// ordem ({ label, overnight }). Retorna o roteiro dia a dia.
export function buildPlan(trip, stops, prefs, depart) {
  const P = { ...DEFAULT_PREFS, ...prefs };
  const total = trip.distance;
  const speed = total / trip.duration; // m/s médio previsto
  const pois = trip.pois || [];

  // Fim de cada perna (onde fica cada parada escolhida pelo usuário).
  const legEnds = [];
  let acc = 0;
  for (const l of trip.legs || [{ distance: total }]) { acc += l.distance; legEnds.push(Math.min(acc, total)); }
  const userStops = stops.map((s, i) => ({ ...s, along: legEnds[i] }));

  const days = [];
  let along = 0;
  let clock = new Date(depart);
  let day = { n: 1, date: new Date(clock), start: { along: 0, time: new Date(clock) }, items: [], driveSec: 0 };
  let sinceBreak = 0; // segundos dirigindo desde a última pausa
  const maxDay = P.maxDriveH * 3600;
  const breakEvery = P.breakEveryMin * 60;
  const nightWarn = new Set();

  const advance = (to) => {
    const sec = (to - along) / speed;
    // Marca dirigida de madrugada (22h–5h).
    for (let t = 0; t < sec; t += 900) {
      const h = new Date(clock.getTime() + t * 1000).getHours();
      if (h >= 22 || h < 5) nightWarn.add(day.n);
    }
    clock = new Date(clock.getTime() + sec * 1000);
    day.driveSec += sec;
    sinceBreak += sec;
    along = to;
  };

  const endDay = (stop) => {
    day.end = { along, time: new Date(clock), ...stop };
    day.distance = along - day.start.along;
    days.push(day);
    const next = new Date(clock);
    next.setDate(next.getDate() + 1);
    next.setHours(P.nextDayHour, 0, 0, 0);
    // Chegou de madrugada? Sai no horário escolhido do mesmo dia seguinte ao descanso.
    if (next - clock < 7 * 3600000) next.setTime(clock.getTime() + 8 * 3600000);
    clock = next;
    day = { n: days.length + 1, date: new Date(clock), start: { along, time: new Date(clock) }, items: [], driveSec: 0 };
    sinceBreak = 0;
  };

  let guard = 0;
  while (along < total - 50 && guard++ < 500) {
    // Próximo evento: parada do usuário, pausa, limite do dia ou chegada.
    const nextUser = userStops.find((s) => s.along > along + 50);
    const breakAt = along + Math.max(0, breakEvery - sinceBreak) * speed;
    // Se depois do limite do dia faltar pouco (até 1h30), segue direto até o fim.
    let dayLimitAt = along + Math.max(0, maxDay - day.driveSec) * speed;
    if ((total - dayLimitAt) / speed <= 5400) dayLimitAt = Infinity;
    const candidates = [
      { kind: 'end', at: total },
      ...(nextUser ? [{ kind: 'user', at: nextUser.along, stop: nextUser }] : []),
      { kind: 'break', at: breakAt },
      { kind: 'night', at: dayLimitAt },
    ].sort((a, b) => a.at - b.at);
    const ev = candidates[0];

    if (ev.kind === 'end') { advance(total); break; }

    if (ev.kind === 'user') {
      advance(ev.at);
      if (ev.stop.overnight) { endDay({ label: ev.stop.label, overnight: true, user: true }); continue; }
      day.items.push({ type: 'city', along, time: new Date(clock), label: ev.stop.label });
      const pause = P.breakMin * 60;
      clock = new Date(clock.getTime() + pause * 1000);
      sinceBreak = 0;
      continue;
    }

    if (ev.kind === 'night') {
      // Para o dia num posto/área de descanso perto do limite (cidade é sugerida depois).
      const st = bestStop(pois, ev.at, { from: day.start.along });
      const at = st && st.poi.along > along ? st.poi.along : ev.at;
      advance(at);
      endDay({ label: '', overnight: true, suggested: true, poi: st?.poi || null });
      continue;
    }

    // Pausa
    const meal = mealOf(new Date(clock.getTime() + ((ev.at - along) / speed) * 1000));
    const st = bestStop(pois, ev.at, { from: along, meal });
    if (st && st.poi.along > along + 5 * KM) {
      advance(st.poi.along);
      day.items.push({ type: 'break', along, time: new Date(clock), poi: st.poi, food: st.food, meal: mealOf(clock) });
    } else {
      advance(Math.min(ev.at, total));
      day.items.push({ type: 'break', along, time: new Date(clock), poi: null, meal: mealOf(clock) });
    }
    const pauseMin = day.items[day.items.length - 1].meal === 'almoço' || day.items[day.items.length - 1].meal === 'jantar' ? P.mealMin : P.breakMin;
    clock = new Date(clock.getTime() + pauseMin * 60000);
    sinceBreak = 0;
  }
  day.end = { along: total, time: new Date(clock), label: 'Destino', arrival: true };
  day.distance = total - day.start.along;
  days.push(day);

  // Pedágios por dia e totais.
  const toll = tollEstimate(pois, P.tollAvg);
  for (const d of days) {
    d.tolls = toll.plazas.filter((p) => p.along >= d.start.along && p.along < d.end.along + 1);
    d.tollCost = d.tolls.reduce((a, p) => a + (p.price || P.tollAvg), 0);
    d.night = nightWarn.has(d.n);
  }
  const liters = total / KM / P.kmPerL;
  return {
    prefs: P,
    depart: new Date(depart).toISOString(),
    days,
    totals: {
      distance: total,
      driveSec: trip.duration,
      liters,
      fuelCost: liters * P.fuelPrice,
      tollCost: toll.total,
      plazas: toll.plazas.length,
      tollKnown: toll.known,
      nights: days.length - 1,
    },
  };
}

// Paradas que o navegador deve anunciar durante a viagem.
export function plannedStops(plan) {
  const out = [];
  for (const d of plan?.days || []) {
    for (const it of d.items) {
      if (it.type === 'break' && it.poi) out.push({ along: it.poi.along, name: it.poi.name, kind: it.meal || 'pausa' });
    }
    if (d.end?.overnight) out.push({ along: d.end.along, name: d.end.label || d.end.poi?.name || 'pernoite', kind: 'pernoite' });
  }
  return out;
}

export const money = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
