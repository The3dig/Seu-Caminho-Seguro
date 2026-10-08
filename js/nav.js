// Motor de navegação: acompanha o GPS na rota FIXA (sem recálculo), avisa
// radares, manobras, postos e cansaço. Também funciona sem rota ("só radar").
import { dist, bearing, angleDiff, locate, makeLine, pointAt, fmtDist } from './geo.js';

function sayDist(m) {
  if (m < 1000) return `${Math.max(50, Math.round(m / 50) * 50)} metros`;
  const km = Math.round(m / 100) / 10;
  if (km < 1.05) return '1 quilômetro';
  return `${String(km).replace('.', ',')} quilômetros`;
}
import { isActive } from './radars.js';
import { speak, beep } from './voice.js';

const OFF_ROUTE_M = 80;
const RADAR_ON_ROUTE_M = 45;

export class Nav {
  constructor({ trip, radars, settings, ui }) {
    this.trip = trip;
    this.settings = settings;
    this.ui = ui;
    this.walk = !!settings.walkTest;
    // A pé, os avisos começam bem mais perto para dar pra testar num quarteirão.
    this.thresholds = this.walk ? [300, 150, 50] : [...settings.alertDist].sort((a, b) => b - a);
    this.line = trip ? makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon }))) : null;
    this.allRadars = radars;
    this.routeRadars = this.line ? this.projectRadars(radars) : [];
    this.pois = trip?.pois || [];
    this.steps = trip?.steps || [];
    this.progress = 0;
    this.hint = 0;
    this.offCount = 0;
    this.offRoute = false;
    this.spoken = new Map(); // radarId -> menor limiar já anunciado
    this.asked = new Set(); // radares cuja confirmação já foi pedida
    this.stepSpoken = new Map();
    this.fuelPassed = new Set();
    this.freeNear = new Map(); // modo só radar: id -> menor distância vista
    this.lastFix = null;
    this.movingSec = 0;
    this.stoppedSec = 0;
    this.nextFatigueAt = this.fatigueLimit();
    this.lastOverBeep = 0;
    this.arrived = false;
    this.startedAt = Date.now();
  }

  projectRadars(radars) {
    const out = [];
    for (const r of radars) {
      if (!isActive(r)) continue;
      const loc = locate(this.line, r, 0, this.line.pts.length - 1, RADAR_ON_ROUTE_M);
      if (!loc) continue;
      // Radar com sentido conhecido: ignora se for da pista contrária.
      if (r.heading != null) {
        const h = pointAt(this.line, loc.along).heading;
        if (angleDiff(h, r.heading) > 70) continue;
      }
      out.push({ r, along: loc.along });
    }
    return out.sort((a, b) => a.along - b.along);
  }

  // Inclui um radar recém-marcado na viagem em andamento.
  addRadar(r) {
    this.allRadars = [...this.allRadars.filter((x) => x.id !== r.id), r];
    if (this.line) {
      const loc = locate(this.line, r, 0, this.line.pts.length - 1, RADAR_ON_ROUTE_M);
      if (loc && !this.routeRadars.some((x) => x.r.id === r.id)) {
        this.routeRadars.push({ r, along: loc.along });
        this.routeRadars.sort((a, b) => a.along - b.along);
      }
    }
    this.spoken.set(r.id, 0);
    this.asked.add(r.id);
  }

  removeRadar(id) {
    this.routeRadars = this.routeRadars.filter((x) => x.r.id !== id);
    this.allRadars = this.allRadars.filter((x) => x.id !== id);
  }

  update(fix) {
    const prev = this.lastFix;
    const dt = prev ? Math.min(10, (fix.time - prev.time) / 1000) : 0;
    let speed = fix.speed;
    if ((speed == null || isNaN(speed)) && prev && dt > 0) speed = dist(prev, fix) / dt;
    speed = speed || 0;
    let heading = fix.heading;
    if ((heading == null || isNaN(heading)) && prev && dist(prev, fix) > 3) heading = bearing(prev, fix);
    if (heading == null || isNaN(heading)) heading = prev?.heading ?? null;
    const f = { ...fix, speed, heading };
    this.lastFix = f;
    const kmh = speed * 3.6;

    this.trackFatigue(kmh, dt);

    const state = { kmh, heading, fix: f, radar: null, off: false };
    if (this.line) this.updateRoute(f, kmh, state);
    else this.updateFree(f, kmh, state);
    this.ui.render(state);
  }

  // ---------- Com rota ----------
  updateRoute(f, kmh, state) {
    const n = this.line.pts.length - 1;
    let loc = locate(this.line, f, Math.max(0, this.hint - 30), Math.min(n, this.hint + 250));
    if (!loc || loc.offset > 150) {
      const full = locate(this.line, f);
      if (full && (!loc || full.offset < loc.offset)) loc = full;
    }
    if (loc) {
      if (loc.offset > OFF_ROUTE_M) this.offCount++;
      else this.offCount = 0;
      if (loc.offset <= OFF_ROUTE_M) {
        this.hint = loc.index;
        this.progress = loc.along;
      }
    }
    const wasOff = this.offRoute;
    this.offRoute = this.offCount >= 3;
    if (this.offRoute && !wasOff) {
      speak('Atenção: você saiu da rota planejada. A rota não será alterada. Volte para o trajeto.', { urgent: true });
      beep({ times: 1, freq: 500 });
    }
    if (!this.offRoute && wasOff) speak('Você voltou para a rota planejada.');
    state.off = this.offRoute;
    state.offDist = loc?.offset;
    if (this.offRoute) {
      const near = pointAt(this.line, loc.along);
      state.backBearing = bearing(f, near);
    }

    const p = this.progress;
    const total = this.line.length;
    state.progress = p;
    state.remaining = Math.max(0, total - p);
    state.remainingSec = this.trip.duration * (state.remaining / total);
    state.total = total;

    // Radares
    if (!this.offRoute) {
      const ahead = this.routeRadars.find((x) => x.along > p - 15);
      if (ahead) {
        const d = ahead.along - p;
        this.alertRadar(ahead.r, d, kmh);
        if (d <= this.thresholds[0]) state.radar = { r: ahead.r, d, over: ahead.r.limit && kmh > ahead.r.limit + 2 };
      }
      for (const x of this.routeRadars) {
        if (x.along > p - 40) break;
        if (this.spoken.has(x.r.id) && !this.asked.has(x.r.id)) {
          this.asked.add(x.r.id);
          this.ui.askConfirm(x.r);
        }
      }
    }

    // Manobras
    const step = this.steps.find((s) => s.along > p + 15);
    if (step) {
      const d = step.along - p;
      state.step = step;
      state.stepDist = d;
      this.announceStep(step, d, kmh);
    }
    if (!this.arrived && state.remaining < 40) {
      this.arrived = true;
      speak('Você chegou ao destino. Boa viagem e bom descanso!');
      state.arrived = true;
    }

    // Postos e paradas à frente
    const avg = total / this.trip.duration; // m/s médio previsto
    const next = {};
    for (const cat of ['fuel', 'food', 'rest', 'lodging']) {
      next[cat] = this.pois.filter((x) => x.cat === cat && x.along > p - 50).slice(0, 4)
        .map((x) => ({ ...x, d: x.along - p, sec: (x.along - p) / avg }));
    }
    state.next = next;
    this.fuelWarnings(p);
  }

  alertRadar(r, d, kmh) {
    const last = this.spoken.get(r.id) ?? Infinity;
    const crossed = this.thresholds.filter((t) => d <= t);
    if (crossed.length) {
      const t = crossed[crossed.length - 1];
      if (t < last) {
        this.spoken.set(r.id, t);
        const lim = r.limit ? `, limite ${r.limit}` : '';
        const isLast = t === this.thresholds[this.thresholds.length - 1];
        if (isLast) {
          beep({ times: 3, freq: 1000 });
          speak(`Radar${lim}!`, { urgent: true });
        } else {
          beep({ times: 2 });
          speak(`Radar em ${sayDist(d)}${lim}.`, { urgent: true });
        }
      }
    }
    if (r.limit && kmh > r.limit + 2 && d < 500) {
      const now = Date.now();
      if (now - this.lastOverBeep > 4000) {
        this.lastOverBeep = now;
        beep({ times: 2, freq: 1400, dur: 0.1, gap: 0.05 });
        if (d > 150) speak('Reduza a velocidade!', { urgent: true });
      }
    }
  }

  announceStep(step, d, kmh) {
    const key = step.along;
    const done = this.stepSpoken.get(key) || 0;
    const far = this.walk ? 250 : kmh > 70 ? 2000 : 800;
    let level = 0;
    if (d <= (this.walk ? 25 : 120)) level = 3;
    else if (d <= (this.walk ? 100 : 500)) level = 2;
    else if (d <= far) level = 1;
    if (level > done) {
      this.stepSpoken.set(key, level);
      if (step.type === 'arrive') {
        if (level < 3) speak(`Destino em ${sayDist(d)}.`);
      } else if (level === 3) speak(step.text);
      else speak(`Em ${sayDist(d)}, ${step.text.charAt(0).toLowerCase()}${step.text.slice(1)}`);
    }
  }

  fuelWarnings(p) {
    const gapM = this.settings.fuelGapKm * 1000;
    const fuels = this.pois.filter((x) => x.cat === 'fuel');
    if (!this.fuelPassed.has('start') && this.lastFix) {
      this.fuelPassed.add('start');
      const first = fuels.find((x) => x.along > p);
      if (!first || first.along - p > gapM) {
        const d = first ? first.along - p : this.line.length - p;
        setTimeout(() => speak(`Atenção: o próximo posto está a ${Math.round(d / 1000)} quilômetros.`), 4000);
      }
    }
    for (let i = 0; i < fuels.length; i++) {
      const fu = fuels[i];
      if (fu.along > p) break;
      if (this.fuelPassed.has(fu.along)) continue;
      this.fuelPassed.add(fu.along);
      if (p - fu.along > 1000) continue; // já ficou bem pra trás (ex.: retomada)
      const nxt = fuels[i + 1];
      const gap = (nxt ? nxt.along : this.line.length) - fu.along;
      if (gap > gapM) {
        const where = nxt ? `o próximo posto só em ${Math.round(gap / 1000)} quilômetros` : 'não há mais postos até o destino';
        speak(`Atenção: este foi o último posto por um tempo, ${where}.`);
        this.ui.toast(`⛽ Próximo posto só em ${fmtDist(gap)}`, 12000);
      }
    }
  }

  // ---------- Sem rota: só radar ----------
  updateFree(f, kmh, state) {
    if (f.heading == null || kmh < (this.walk ? 1.5 : 8)) return;
    let best = null;
    for (const r of this.allRadars) {
      if (!isActive(r)) continue;
      const d = dist(f, r);
      if (d > 1300) {
        this.freeNear.delete(r.id);
        continue;
      }
      if (r.heading != null && angleDiff(r.heading, f.heading) > 60) continue;
      const ahead = angleDiff(bearing(f, r), f.heading) < (this.walk ? 50 : 35) || d < 40;
      const prevMin = this.freeNear.get(r.id);
      if (ahead) {
        this.freeNear.set(r.id, Math.min(prevMin ?? d, d));
        if (!best || d < best.d) best = { r, d };
      } else if (prevMin != null && prevMin < 120 && d > 50 && this.spoken.has(r.id) && !this.asked.has(r.id)) {
        this.asked.add(r.id);
        this.ui.askConfirm(r);
      }
    }
    if (best) {
      this.alertRadar(best.r, best.d, kmh);
      if (best.d <= this.thresholds[0]) state.radar = { ...best, over: best.r.limit && kmh > best.r.limit + 2 };
    }
  }

  // ---------- Cansaço ----------
  trackFatigue(kmh, dt) {
    if (kmh > 10) {
      this.movingSec += dt;
      this.stoppedSec = 0;
    } else {
      this.stoppedSec += dt;
      if (this.stoppedSec > 10 * 60 && this.movingSec > 0) {
        this.movingSec = 0; // parada de 10 min conta como descanso
        this.nextFatigueAt = this.fatigueLimit();
        this.ui.toast('☕ Descanso registrado. Contador de cansaço zerado.');
      }
    }
    if (this.movingSec >= this.nextFatigueAt) {
      this.nextFatigueAt = this.movingSec + 30 * 60;
      const h = Math.floor(this.movingSec / 3600);
      const m = Math.round((this.movingSec % 3600) / 60);
      const tempo = h ? `${h} hora${h > 1 ? 's' : ''}${m ? ` e ${m} minutos` : ''}` : `${m} minutos`;
      let msg = `Você está dirigindo há ${tempo} sem parar. Que tal uma pausa?`;
      const nf = this.line ? this.pois.find((x) => x.cat === 'fuel' && x.along > this.progress) : null;
      if (nf) msg += ` Próximo posto, ${nf.name}, em ${Math.round((nf.along - this.progress) / 1000)} quilômetros.`;
      speak(msg);
      this.ui.toast('😴 ' + msg, 15000);
    }
  }

  fatigueLimit() {
    const hour = new Date().getHours();
    const night = hour >= 22 || hour < 5;
    return (night ? Math.min(90, this.settings.fatigueMin) : this.settings.fatigueMin) * 60;
  }
}
