// Voz (pt-BR) e bipes. A música abaixa sozinha enquanto o app fala.
let settings = { voice: true, beep: true };
let audioCtx = null;
let duckHandler = { duck() {}, unduck() {} };
let ptVoice = null;
let gaveUp = false;

export function configure(s) { settings = s; pickVoice(); }
export function setDucking(h) { duckHandler = h; }
export const currentVoice = () => ptVoice?.name || '';

// Vozes em português disponíveis no aparelho; as do Brasil e as "aprimoradas"
// (melhor qualidade) primeiro. O iPhone usa "pt-BR", outros "pt_BR".
export const isBR = (v) => /^pt[-_]br$/i.test(v.lang || '');
export function voices() {
  if (!('speechSynthesis' in window)) return [];
  // Brasil primeiro; depois as de melhor qualidade; a Luciana (padrão do iPhone) na frente.
  const score = (v) => (isBR(v) ? 0 : 4) + (/enhanced|aprimorad|premium|neural|natural/i.test(v.name) ? 0 : 2) + (/luciana/i.test(v.name) ? 0 : 1);
  return speechSynthesis.getVoices()
    .filter((v) => /^pt/i.test(v.lang))
    .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const list = voices();
  const chosen = settings.voiceName && list.find((v) => v.name === settings.voiceName);
  // Voz de Portugal só se você escolher; no automático, sempre a do Brasil.
  ptVoice = chosen || list.find(isBR) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  // O Safari do iPhone às vezes demora para listar as vozes (e nem avisa).
  let tries = 0;
  const retry = setInterval(() => { pickVoice(); if (ptVoice || ++tries > 20) clearInterval(retry); }, 500);
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
export function speak(text, { urgent = false, force = false, tries = 0 } = {}) {
  if ((!settings.voice && !force) || !('speechSynthesis' in window)) return;
  // Vozes ainda não carregaram (iPhone)? Espera um pouco para não sair com
  // sotaque de Portugal. Alerta urgente (radar) fala na hora mesmo assim.
  if (!ptVoice) pickVoice();
  if (!ptVoice && !urgent && !gaveUp && tries < 4 && !voices().length) {
    setTimeout(() => speak(text, { urgent, force, tries: tries + 1 }), 750);
    return;
  }
  if (tries >= 4) gaveUp = true; // aparelho sem vozes listadas: não espera de novo
  // iPhone: a voz às vezes fica "pausada" sozinha (ligação, notificação, Siri).
  if (speechSynthesis.paused) speechSynthesis.resume();
  const make = () => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = ptVoice?.lang?.replace('_', '-') || 'pt-BR';
    // Uma voz inválida nunca pode impedir um alerta: cai para a voz padrão.
    try { if (ptVoice) u.voice = ptVoice; } catch { /* voz padrão */ }
    u.rate = settings.voiceRate || 1.05;
    u.onend = u.onerror = () => { if (!speechSynthesis.pending) duckHandler.unduck(); };
    return u;
  };
  duckHandler.duck();
  if (!urgent) { speechSynthesis.speak(make()); return; }
  // Alerta urgente (radar): corta o que estiver falando. No Safari do iPhone,
  // falar logo depois de cancelar às vezes não sai som nenhum (foi o radar que
  // só avisou a 1000 m): só cancela se estiver falando, espera um instante, e
  // se a fala não começar em 1,5 s, tenta de novo.
  const busy = speechSynthesis.speaking || speechSynthesis.pending;
  if (busy) speechSynthesis.cancel();
  const go = (again) => {
    const u = make();
    let started = false;
    u.onstart = () => { started = true; };
    speechSynthesis.speak(u);
    if (again) setTimeout(() => { if (!started) go(false); }, 1500); // não começou: fala de novo
  };
  if (busy) setTimeout(() => go(true), 150); else go(true);
}

export function beep({ times = 2, freq = 880, dur = 0.16, gap = 0.1, force = false } = {}) {
  if ((!settings.beep && !force) || !audioCtx) return;
  // O iPhone "suspende" o áudio depois de interrupções: acorda antes de bipar.
  if (audioCtx.state !== 'running') audioCtx.resume?.().catch(() => {});
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
