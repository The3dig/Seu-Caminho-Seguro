// Player de músicas offline. As faixas (ex.: seus MP3 do Nat King Cole) ficam
// salvas no próprio celular via IndexedDB e tocam sem internet.
import { tracks as store, uid } from './store.js';

const audio = new Audio();
audio.preload = 'auto';
let list = [];
let idx = 0;
let baseVolume = 1;
let ducked = false;
const listeners = new Set();

function emit() { for (const fn of listeners) fn(state()); }
export function onChange(fn) { listeners.add(fn); }

export function state() {
  return { playing: !audio.paused, track: list[idx] || null, count: list.length, index: idx };
}

export async function load() {
  list = (await store.all()).sort((a, b) => (a.order ?? a.added) - (b.order ?? b.added));
  emit();
  return list;
}

export function tracks() { return list; }

export async function addFiles(files) {
  let n = list.length;
  for (const f of files) {
    if (!f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(f.name)) continue;
    await store.put({ id: uid(), name: f.name.replace(/\.[^.]+$/, ''), blob: f, added: Date.now(), order: n++ });
  }
  return load();
}

export async function removeTrack(id) {
  const wasCurrent = list[idx]?.id === id;
  await store.del(id);
  await load();
  if (wasCurrent) { audio.pause(); idx = 0; }
  emit();
}

function setSrc() {
  const t = list[idx];
  if (!t) return false;
  if (audio.dataset.id !== t.id) {
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(t.blob);
    audio.dataset.id = t.id;
  }
  return true;
}

export async function play(i) {
  if (i != null) idx = i;
  if (!setSrc()) return false;
  try { await audio.play(); } catch { return false; }
  emit();
  updateMediaSession();
  return true;
}

export function pause() { audio.pause(); emit(); }
export function toggle() { return audio.paused ? play() : pause(); }
export function next() { if (!list.length) return; idx = (idx + 1) % list.length; play(); }
export function prev() { if (!list.length) return; idx = (idx - 1 + list.length) % list.length; play(); }

export function shuffle() {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  idx = 0;
  emit();
}

export function setVolume(v) { baseVolume = v; audio.volume = ducked ? v * 0.25 : v; }
export function duck() { ducked = true; audio.volume = baseVolume * 0.25; }
export function unduck() { ducked = false; audio.volume = baseVolume; }

audio.addEventListener('ended', next);
audio.addEventListener('pause', emit);
audio.addEventListener('play', emit);

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = list[idx];
  navigator.mediaSession.metadata = new MediaMetadata({ title: t?.name || '', artist: 'Trilha da viagem' });
  navigator.mediaSession.setActionHandler('play', () => play());
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}
