// Geometria básica: distâncias, projeção de pontos na rota, simplificação.
const R = 6371000;
const D2R = Math.PI / 180;

export function dist(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * D2R) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) -
    Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lon - a.lon) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Coordenadas planas (metros) relativas a ref — suficiente para distâncias curtas.
function xy(p, ref) {
  return {
    x: (p.lon - ref.lon) * D2R * R * Math.cos(ref.lat * D2R),
    y: (p.lat - ref.lat) * D2R * R,
  };
}

export function projSeg(p, a, b) {
  const A = xy(a, p), B = xy(b, p);
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = dx * dx + dy * dy;
  let t = L ? -(A.x * dx + A.y * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return { t, d: Math.hypot(A.x + t * dx, A.y + t * dy) };
}

export function makeLine(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

// Localiza p na linha. from/to limitam a busca (índices de segmento).
// maxOffset (m) permite descartar rapidamente segmentos distantes.
export function locate(line, p, from = 0, to = line.pts.length - 1, maxOffset = Infinity) {
  const pts = line.pts;
  const deg = maxOffset === Infinity ? Infinity : maxOffset / 111000 + 0.002;
  const degLon = deg / Math.max(0.2, Math.cos(p.lat * D2R));
  let best = null;
  const end = Math.min(to, pts.length - 1);
  for (let i = Math.max(0, from); i < end; i++) {
    const a = pts[i], b = pts[i + 1];
    if (deg !== Infinity) {
      if ((a.lat - p.lat > deg && b.lat - p.lat > deg) || (p.lat - a.lat > deg && p.lat - b.lat > deg)) continue;
      if ((a.lon - p.lon > degLon && b.lon - p.lon > degLon) || (p.lon - a.lon > degLon && p.lon - b.lon > degLon)) continue;
    }
    const r = projSeg(p, a, b);
    if (!best || r.d < best.d) best = { d: r.d, i, t: r.t };
  }
  if (!best || best.d > maxOffset) return null;
  const segLen = line.cum[best.i + 1] - line.cum[best.i];
  return { index: best.i, offset: best.d, along: line.cum[best.i] + best.t * segLen };
}

export function pointAt(line, along) {
  const { pts, cum } = line;
  if (along <= 0) return { ...pts[0], heading: bearing(pts[0], pts[1] || pts[0]), index: 0 };
  if (along >= line.length) {
    const n = pts.length - 1;
    return { ...pts[n], heading: bearing(pts[Math.max(0, n - 1)], pts[n]), index: n - 1 };
  }
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[lo + 1];
  const t = (along - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1);
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, heading: bearing(a, b), index: lo };
}

// Douglas-Peucker iterativo (tolerância em metros).
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projSeg(pts[i], pts[s], pts[e]).d;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function fmtDist(m) {
  if (m == null || !isFinite(m)) return '--';
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

export function fmtDur(s) {
  if (s == null || !isFinite(s)) return '--';
  const m = Math.round(s / 60);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

export function fmtClock(date) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
