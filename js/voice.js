// Voz (pt-BR) e bipes. A música abaixa sozinha enquanto o app fala.
let settings = { voice: true, beep: true };
let audioCtx = null;
let duckHandler = { duck() {}, unduck() {} };
let ptVoice = null;

export function configure(s) { settings = s; pickVoice(); }
export function setDucking(h) { duckHandler = h; }
export const currentVoice = () => ptVoice?.name || '';

// Vozes em português disponíveis no aparelho; as do Brasil e as "aprimoradas"
// (melhor qualidade) primeiro.
export function voices() {
  if (!('speechSynthesis' in window)) return [];
  const score = (v) => (v.lang === 'pt-BR' || v.lang === 'pt_BR' ? 0 : 2) + (/enhanced|aprimorad|premium|neural|natural/i.test(v.name) ? 0 : 1);
  return speechSynthesis.getVoices()
    .filter((v) => /^pt/i.test(v.lang))
    .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const list = voices();
  ptVoice = (settings.voiceName && list.find((v) => v.name === settings.voiceName)) || list[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

// Precisa ser chamado a partir de um toque do usuário (política dos navegadores).
export function unlock() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sem áudio */ }
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

// force: fala mesmo com a voz desligada (radar e limite no modo insistente).
export function speak(text, { urgent = false, force = false } = {}) {
  if ((!settings.voice && !force) || !('speechSynthesis' in window)) return;
  if (urgent) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR';
  // Uma voz inválida nunca pode impedir um alerta: cai para a voz padrão.
  try { if (ptVoice) u.voice = ptVoice; } catch { /* voz padrão */ }
  u.rate = settings.voiceRate || 1.05;
  duckHandler.duck();
  u.onend = u.onerror = () => { if (!speechSynthesis.pending) duckHandler.unduck(); };
  speechSynthesis.speak(u);
}

export function beep({ times = 2, freq = 880, dur = 0.16, gap = 0.1, force = false } = {}) {
  if ((!settings.beep && !force) || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < times; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    const s = t0 + i * (dur + gap);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.35, s + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(s);
    o.stop(s + dur + 0.02);
  }
  if (navigator.vibrate) navigator.vibrate(Array(times).fill([200, 100]).flat());
}
