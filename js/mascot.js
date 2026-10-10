// Kravenox no mapa: anda igual ao jogo (sprites do kit) e, quando você para,
// faz brincadeiras sozinho — pula, ruge, pisa forte, solta fogo e explode
// prediozinhos de mentira, dorme se a parada for longa e comemora na chegada.
// Andando, as brincadeiras são raras e pequenas, e nunca durante avisos.
const BASE = 'icons/kravenox/';
const NAMES = [];
for (const d of ['down', 'up', 'left', 'right']) for (const f of [0, 1]) NAMES.push(`k_${d}_${f}`);
for (const d of ['left', 'right']) for (const f of [0, 1, 2, 3]) NAMES.push(`k_${d}_w${f}`);
const SCALE = 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const PORTRAIT = BASE + 'k_portrait.png';

export function dirFromHeading(deg) { // 0 = norte (costas), 90 = leste (direita)
  const a = ((deg % 360) + 360) % 360;
  if (a >= 45 && a < 135) return 'right';
  if (a >= 135 && a < 225) return 'down';
  if (a >= 225 && a < 315) return 'left';
  return 'up';
}

export class Mascot {
  constructor() {
    for (const n of NAMES) { const im = new Image(); im.src = BASE + n + '.png'; } // pré-carrega
    const el = document.createElement('div');
    el.className = 'krav upright'; // upright: fica de pé quando o mapa gira
    el.innerHTML = '<div class="k-fx"></div><div class="k-shadow"></div><div class="k-body"><img alt="" draggable="false"></div><div class="k-say" hidden></div>';
    this.el = el;
    this.body = el.querySelector('.k-body');
    this.img = el.querySelector('img');
    this.fx = el.querySelector('.k-fx');
    this.say = el.querySelector('.k-say');
    this.icon = L.divIcon({ html: el, className: '', iconSize: [80, 80], iconAnchor: [40, 70] });
    this.dir = 'down';
    this.moving = false;
    this.speed = 1;
    this.walkF = 0;
    this.t = 0;
    this.override = null; // quadro forçado durante uma brincadeira
    this.busyUntil = 0;
    this.stillSince = Date.now();
    this.nextAntic = Date.now() + 4000;
    this.nextMoveAntic = Date.now() + rand(90, 180) * 1000;
    this.sleeping = false;
    this.partied = false;
    this.timers = [];
    this.running = false;
    this.setFrame();
  }

  // Chamado a cada posição do GPS.
  // mode: 'always' (parado + discreto andando) | 'stopped' | 'off'; quiet = tem aviso na tela.
  update({ kmh = 0, heading = null, arrived = false, quiet = false, mode = 'always' }) {
    const now = Date.now();
    const moving = kmh > 3;
    if (moving) {
      if (heading != null && !this.busy()) this.dir = dirFromHeading(heading);
      this.speed = Math.min(2.5, Math.max(1, kmh / 30));
      this.stillSince = now;
      if (this.sleeping) this.wake();
      if (this.busy() && this.current !== 'whip') this.cancel(); // começou a andar: para a brincadeira
    }
    this.moving = moving;
    if (!arrived) this.partied = false;
    this.start();
    if (mode === 'off') { if (this.sleeping) this.wake(); return; }
    if (arrived && !this.partied && !moving) { this.partied = true; this.cancel(); this.play('party'); return; }
    if (this.busy() || quiet) return;
    if (moving) {
      if (mode === 'always' && now > this.nextMoveAntic) {
        this.nextMoveAntic = now + rand(150, 300) * 1000;
        this.play('whip');
      }
      return;
    }
    const still = now - this.stillSince;
    if (still > 180000) { if (!this.sleeping) this.sleep(); return; }
    if (still > 3000 && now > this.nextAntic) {
      this.nextAntic = now + rand(6, 13) * 1000;
      this.play(pick(['boom', 'boom', 'jump', 'roar', 'stomp', 'look', 'spin', 'espinhos', 'furia', 'salto', 'raio', 'pesca', 'pesca', 'mao', 'mao', 'et', 'et']));
    }
  }

  busy() { return Date.now() < this.busyUntil; }
  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  cancel() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.busyUntil = 0;
    this.override = null;
    this.current = null;
    this.body.className = 'k-body';
    this.fx.innerHTML = '';
    this.say.hidden = true;
    this.say.hidden = true;
    this.setFrame();
  }
  bubble(text, ms) {
    this.say.textContent = text;
    this.say.hidden = false;
    this.later(ms, () => { this.say.hidden = true; });
  }
  bodyAnim(cls, ms) {
    this.body.className = 'k-body';
    void this.body.offsetWidth; // reinicia a animação CSS
    this.body.classList.add(cls);
    this.later(ms, () => this.body.classList.remove(cls));
  }
  spawn(cls, x, y, html = '', ms = 1500) { // x,y relativos aos pés
    const d = document.createElement('div');
    d.className = cls;
    d.style.left = `${40 + x}px`;
    d.style.top = `${70 + y}px`;
    d.innerHTML = html;
    this.fx.appendChild(d);
    this.later(ms, () => d.remove());
    return d;
  }

  play(name) {
    const dur = { jump: 1300, roar: 1600, stomp: 1300, look: 2200, spin: 1100, boom: 3200, whip: 1400, party: 4200, espinhos: 1800, furia: 2200, salto: 2000, raio: 3000, pesca: 5200, mao: 4200, et: 4800 }[name] || 1500;
    this.current = name;
    this.busyUntil = Date.now() + dur;
    this.later(dur, () => { this.override = null; this.current = null; this.setFrame(); });
    const side = Math.random() < 0.5 ? -1 : 1;
    switch (name) {
      case 'jump':
        this.bodyAnim('k-jump2', 1200);
        this.later(500, () => this.spawn('k-dust', 0, -4, '', 700));
        this.later(1150, () => this.spawn('k-dust', 0, -4, '', 700));
        break;
      case 'roar':
        this.override = 'k_down_1';
        this.bodyAnim('k-shake', 1400);
        this.bubble(pick(['RAAAWR!', 'GRRRR!', 'ROOOAR!']), 1500);
        break;
      case 'stomp':
        this.bodyAnim('k-stomp', 1100);
        this.later(550, () => {
          this.spawn('k-dust', -22, -4, '', 800);
          this.spawn('k-dust', 22, -4, '', 800);
          this.spawn('k-crack', 0, -2, '', 900);
        });
        break;
      case 'look':
        this.override = 'k_left_0';
        this.later(600, () => { this.override = 'k_right_0'; this.setFrame(); });
        this.later(1300, () => { this.override = 'k_down_0'; this.setFrame(); });
        this.later(1350, () => this.bubble('?', 700));
        break;
      case 'spin': {
        const seq = ['k_right_0', 'k_up_0', 'k_left_0', 'k_down_0', 'k_right_0', 'k_up_0', 'k_left_0', 'k_down_0'];
        seq.forEach((f, i) => this.later(i * 120, () => { this.override = f; this.setFrame(); }));
        this.bodyAnim('k-hop', 900);
        break;
      }
      case 'espinhos': // Espinhos Vorazes: espinhos brotam do chão em volta
        this.override = 'k_down_1';
        this.bubble('Espinhos Vorazes!', 1600);
        this.bodyAnim('k-hop', 500);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          this.later(250 + i * 60, () => {
            const e = this.spawn('k-spike', Math.cos(a) * 34, Math.sin(a) * 12 - 2, '', 1300);
            e.style.transform = `translateX(-50%) rotate(${Math.round(Math.cos(a) * 25)}deg)`;
          });
        }
        break;
      case 'furia': // Modo Fúria: aura vermelha pulsando e tremor
        this.override = 'k_down_1';
        this.body.classList.add('k-rage');
        this.later(2000, () => this.body.classList.remove('k-rage'));
        this.bodyAnim('k-shake', 1400);
        this.bubble('MODO FÚRIA!', 1800);
        break;
      case 'salto': // Salto Predador + Esmagamento: pulo alto e onda de impacto
        this.bodyAnim('k-leap', 1100);
        this.later(1000, () => {
          this.spawn('k-wave', 0, -2, '', 900);
          this.spawn('k-dust', -26, -4, '', 800);
          this.spawn('k-dust', 26, -4, '', 800);
        });
        this.later(1050, () => this.bubble('Esmagamento!', 900));
        break;
      case 'pesca': { // pescando: vara, linha, boia… e às vezes vem uma bota
        this.override = 'k_right_0';
        const rod = this.spawn('k-rod', 10, -30, '', 5100);
        const line = this.spawn('k-line', 46, -58, '', 5100);
        const bob = this.spawn('k-bobber', 46, -4, '', 5100);
        this.later(2600, () => { bob.classList.add('bite'); this.bubble('!', 600); });
        this.later(3300, () => {
          rod.classList.add('pull'); line.remove(); bob.remove();
          const boot = Math.random() < 0.25;
          this.spawn('k-catch', 40, -12, boot ? '👢' : '🐟', 1800);
          this.bubble(boot ? '…uma bota?' : 'Peguei!', 1700);
          this.later(150, () => this.bodyAnim('k-hop', 500));
        });
        break;
      }
      case 'mao': { // uma mão gigante desce, levanta ele… e ele solta fogo de raiva
        this.override = 'k_down_0';
        const hand = this.spawn('k-hand', 0, -150, '🫳', 2600);
        this.later(900, () => { this.body.classList.add('k-lift'); hand.classList.add('up'); this.override = 'k_down_1'; this.setFrame(); this.bubble('Ei!', 800); });
        this.later(2100, () => { this.body.classList.remove('k-lift'); this.body.classList.add('k-drop'); hand.remove(); });
        this.later(2500, () => {
          this.body.classList.remove('k-drop');
          this.bodyAnim('k-shake', 900);
          this.bubble('GRRRR!', 1400);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            this.spawn('k-flame', Math.cos(a) * 46, Math.sin(a) * 22 - 18, '🔥', 450); // fogo em tudo, num piscar
          }
          this.spawn('k-flash', 0, -30, '', 300);
        });
        break;
      }
      case 'et': { // a bicicleta voando na frente da lua
        this.spawn('k-moon', 0, -78, '', 4700);
        this.body.classList.add('k-gone');
        this.later(400, () => this.spawn('k-etride', 0, -78, `<span class="bike">🚲</span><img src="${BASE}k_right_1.png" alt="">`, 3300));
        this.later(3900, () => { this.body.classList.remove('k-gone'); this.bodyAnim('k-hop', 600); this.bubble('Minha casa…', 1200); });
        break;
      }
      case 'raio': // Raio da Essência: o mesmo prediozinho, mas com raio roxo
        this.boom(side, 1, true);
        break;
      case 'boom': this.boom(side, 1); break;
      case 'whip': this.boom(side, 0.6); break;
      case 'party':
        this.override = 'k_down_1';
        this.bubble('Chegamos! 🏁', 3800);
        for (let i = 0; i < 3; i++) this.later(i * 1100, () => this.bodyAnim('k-jump', 900));
        for (let i = 0; i < 8; i++) {
          this.later(200 + i * 420, () => this.spawn('k-spark', rand(-60, 60), rand(-90, -40), pick(['🎆', '🎇', '✨', '🎉']), 1100));
        }
        break;
    }
    this.setFrame();
  }

  // Prediozinho de mentira ao lado, bafo de fogo e cabum. size < 1 = versão discreta.
  boom(side, size, essence = false) {
    const far = 64 * size;
    this.override = `k_${side < 0 ? 'left' : 'right'}_0`;
    const b = this.spawn('k-bld', side * far, 0, '', 3000);
    b.style.transform = `translateX(-50%) scale(${size})`;
    this.later(size < 1 ? 250 : 700, () => {
      this.override = `k_${side < 0 ? 'left' : 'right'}_1`;
      this.setFrame();
      const beam = this.spawn(essence ? 'k-beam essence' : 'k-beam', side * 12, -30 * size, '', 700);
      beam.style.width = `${far - 18}px`;
      if (side < 0) { beam.style.transformOrigin = 'right center'; beam.style.left = `${40 - 12 - (far - 18)}px`; }
    });
    this.later(size < 1 ? 650 : 1200, () => {
      b.classList.add('down');
      const e = this.spawn('k-boom', side * far, -18 * size, '💥', 1200);
      e.style.fontSize = `${Math.round(40 * size)}px`;
      if (size >= 1) {
        this.spawn('k-smoke', side * far - 8, -10, '', 1600);
        this.spawn('k-smoke', side * far + 8, -14, '', 1700);
        this.later(300, () => this.bodyAnim('k-hop', 600));
      }
    });
  }

  sleep() {
    this.sleeping = true;
    this.override = 'k_down_0';
    this.body.classList.add('k-sleep');
    const z = document.createElement('div');
    z.className = 'k-zzz';
    z.innerHTML = '<span>z</span><span>Z</span><span>z</span>';
    this.fx.appendChild(z);
    this.zzz = z;
    this.setFrame();
  }
  wake() {
    this.sleeping = false;
    this.override = null;
    this.body.classList.remove('k-sleep');
    this.zzz?.remove();
    this.zzz = null;
  }

  setFrame() {
    let n;
    if (this.override) n = this.override;
    else if (!this.moving) n = `k_${this.dir}_0`;
    else if (this.dir === 'left' || this.dir === 'right') n = `k_${this.dir}_w${this.walkF & 3}`;
    else n = `k_${this.dir}_${[1, 0, 1, 0][this.walkF & 3]}`;
    if (n !== this.frame) {
      this.frame = n;
      this.img.src = BASE + n + '.png';
    }
  }

  // Passo igual ao do jogo: troca de quadro a cada ~0,133 s, mais rápido com mais velocidade.
  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (ts) => {
      if (!this.el.isConnected) { this.running = false; this.cancel(); if (this.sleeping) this.wake(); return; }
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      if (this.moving && !this.override) {
        this.t += dt * 60 * this.speed;
        while (this.t >= 8) { this.t -= 8; this.walkF++; }
      }
      this.setFrame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
