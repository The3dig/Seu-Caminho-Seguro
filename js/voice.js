// Voz (pt-BR) e bipes. A música abaixa sozinha enquanto o app fala.
let settings = { voice: true, beep: true };
let audioCtx = null;
let duckHandler = { duck() {}, unduck() {} };
let ptVoice = null;

export function configure(s) { settings = s; }
export function setDucking(h) { duckHandler = h; }

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  ptVoice = voices.find((v) => v.lang === 'pt-BR') || voices.find((v) => v.lang?.startsWith('pt')) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
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

export function speak(text, { urgent = false } = {}) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  if (urgent) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR';
  if (ptVoice) u.voice = ptVoice;
  u.rate = 1.05;
  duckHandler.duck();
  u.onend = u.onerror = () => { if (!speechSynthesis.pending) duckHandler.unduck(); };
  speechSynthesis.speak(u);
}

export function beep({ times = 2, freq = 880, dur = 0.16, gap = 0.1 } = {}) {
  if (!settings.beep || !audioCtx) return;
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
