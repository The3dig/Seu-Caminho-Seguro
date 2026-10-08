// Lugares fixos (casa, trabalho, favoritos), destinos recentes/frequentes e
// histórico das viagens dirigidas (com o trajeto percorrido).
import { kv, uid } from './store.js';
import { dist } from './geo.js';

// ---------- Lugares fixos ----------
export const ICONS = ['🏠', '💼', '⭐', '👪', '🏋️', '🏫', '🛒', '🏥', '⛪', '🏖️', '🍽️', '⛽'];

export async function favorites() {
  return (await kv.get('places')) || [];
}

export async function getKind(kind) {
  return (await favorites()).find((p) => p.kind === kind) || null;
}

// kind: 'home' | 'work' | 'fav'. Casa e trabalho são únicos.
export async function saveFavorite(p) {
  let list = await favorites();
  // Só pode haver uma Casa principal e um Trabalho: o anterior vira um lugar
  // comum (não é apagado).
  if (p.kind === 'home' || p.kind === 'work') {
    for (const x of list) if (x.kind === p.kind && x.id !== p.id) x.kind = 'fav';
  }
  const item = { id: p.id || uid(), kind: p.kind || 'fav', name: p.name, icon: p.icon, lat: p.lat, lon: p.lon, label: p.label || '', num: p.num || '' };
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  list.sort((a, b) => order(a) - order(b));
  await kv.set('places', list);
  return item;
}

function order(p) {
  return p.kind === 'home' ? 0 : p.kind === 'work' ? 1 : 2;
}

export async function removeFavorite(id) {
  await kv.set('places', (await favorites()).filter((p) => p.id !== id));
}

// "casa", "trabalho" ou o nome de um favorito digitado no campo de destino.
export async function matchFavorite(text) {
  const t = norm(text);
  if (!t) return null;
  const list = await favorites();
  return list.find((p) => norm(p.name) === t) ||
    (t === 'casa' || t === 'minha casa' ? list.find((p) => p.kind === 'home') : null) ||
    (t === 'trabalho' || t === 'servico' ? list.find((p) => p.kind === 'work') : null);
}

function norm(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ---------- Recentes / frequentes ----------
export async function recents() {
  return (await kv.get('recents')) || [];
}

export async function addRecent(p) {
  if (!p || p.label === 'Minha localização') return;
  // Casa, trabalho e favoritos já têm atalho próprio.
  if ((await favorites()).some((f) => dist(f, p) < 150)) return;
  const list = await recents();
  const near = list.find((r) => dist(r, p) < 150);
  if (near) {
    near.count++;
    near.last = Date.now();
    if (p.label && p.label.length < near.label.length) near.label = p.label;
  } else {
    list.push({ id: uid(), lat: p.lat, lon: p.lon, label: p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, count: 1, last: Date.now() });
  }
  // Mantém os 40 mais relevantes.
  list.sort((a, b) => score(b) - score(a));
  await kv.set('recents', list.slice(0, 40));
}

// Frequência pesa mais, mas o que foi usado recentemente também sobe.
export function score(r) {
  const days = (Date.now() - r.last) / 86400000;
  return r.count * 2 + Math.max(0, 10 - days);
}

export async function suggestions(limit = 6) {
  const favs = await favorites();
  return (await recents())
    .filter((r) => !favs.some((f) => dist(f, r) < 150))
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

export async function removeRecent(id) {
  await kv.set('recents', (await recents()).filter((r) => r.id !== id));
}

export async function clearRecents() {
  await kv.set('recents', []);
}

// ---------- Histórico de viagens dirigidas ----------
const MAX_DRIVES = 200;
const MAX_TRACK = 4000;

export async function drives() {
  return (await kv.get('drives')) || [];
}

export async function loadDrive(id) {
  return kv.get('drive:' + id);
}

export class DriveRecorder {
  constructor({ id, tripId = null, name, existing = null }) {
    this.d = existing || {
      id: id || uid(), tripId, name, start: Date.now(), end: Date.now(),
      distance: 0, movingSec: 0, maxKmh: 0, radars: 0, track: [],
    };
    this.last = null;
    this.lastSave = 0;
    if (this.d.track.length) {
      const [lat, lon] = this.d.track[this.d.track.length - 1];
      this.last = { lat, lon };
    }
  }

  get id() { return this.d.id; }

  add(fix, kmh) {
    const d = this.d;
    d.end = Date.now();
    if (fix.accuracy && fix.accuracy > 60) return; // ponto ruim de GPS
    if (kmh > d.maxKmh && kmh < 250) d.maxKmh = kmh;
    const p = { lat: fix.lat, lon: fix.lon };
    if (!this.last) {
      this.last = p;
      this.lastPtT = fix.time;
      d.track.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]);
    } else {
      const step = dist(this.last, p);
      // Salto impossível (> 250 km/h desde o último ponto) = erro de GPS.
      const dt = this.lastPtT ? (fix.time - this.lastPtT) / 1000 : 0;
      const jump = dt > 0 ? step / dt > 70 : step > 1000;
      if (step >= 25 && !jump) {
        this.lastPtT = fix.time;
        d.distance += step;
        this.last = p;
        d.track.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]);
        if (d.track.length > MAX_TRACK) d.track = d.track.filter((_, i) => i % 2 === 0);
      }
    }
    if (kmh > 5 && this.lastT) d.movingSec += Math.min(10, (fix.time - this.lastT) / 1000);
    this.lastT = fix.time;
    if (Date.now() - this.lastSave > 30000) this.save();
  }

  radarPassed() { this.d.radars++; }

  // Paradas fora do roteiro (sono, café, banheiro…).
  addStop(st) {
    const d = this.d;
    d.stops = d.stops || [];
    const item = { id: uid(), lat: +st.lat.toFixed(5), lon: +st.lon.toFixed(5), start: st.start, dur: 0, reason: st.reason || '', place: st.place || '' };
    d.stops.push(item);
    this.save();
    return item;
  }

  updateStop(id, patch) {
    const it = (this.d.stops || []).find((x) => x.id === id);
    if (it) Object.assign(it, patch);
    this.save();
  }

  removeStop(id) {
    this.d.stops = (this.d.stops || []).filter((x) => x.id !== id);
    this.save();
  }

  async save() {
    this.lastSave = Date.now();
    const d = this.d;
    await kv.set('drive:' + d.id, d);
    const meta = { id: d.id, tripId: d.tripId, name: d.name, start: d.start, end: d.end, distance: d.distance, movingSec: d.movingSec, maxKmh: d.maxKmh, radars: d.radars, stops: (d.stops || []).length };
    const list = (await drives()).filter((x) => x.id !== d.id);
    list.unshift(meta);
    for (const old of list.splice(MAX_DRIVES)) await kv.del('drive:' + old.id);
    await kv.set('drives', list);
  }

  // Descarta registros muito curtos (abriu e fechou sem andar).
  async finish() {
    if (this.d.distance < 200) {
      await removeDrive(this.d.id);
      return false;
    }
    await this.save();
    return true;
  }
}

export async function removeDrive(id) {
  await kv.del('drive:' + id);
  await kv.set('drives', (await drives()).filter((x) => x.id !== id));
}

export async function clearDrives() {
  for (const d of await drives()) await kv.del('drive:' + d.id);
  await kv.set('drives', []);
}

// ---------- Viagem em andamento (para retomar se o app fechar) ----------
export const active = {
  get: () => kv.get('activeDrive'),
  set: (v) => kv.set('activeDrive', { ...v, updated: Date.now() }),
  clear: () => kv.del('activeDrive'),
};
