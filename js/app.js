import { getSettings, saveSettings, listTrips, saveTrip, loadTrip, deleteTrip, uid } from './store.js';
import { geocode, route } from './routing.js';
import { fetchAlongRoute, fuelGaps, CATEGORIES } from './pois.js';
import { makeLine, locate, pointAt, fmtDist, fmtDur, fmtClock } from './geo.js';
import * as Radars from './radars.js';
import * as Music from './music.js';
import * as Voice from './voice.js';
import * as Spotify from './spotify.js';
import { Nav } from './nav.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  settings: null,
  alts: [],
  altIdx: 0,
  points: [],
  trip: null,
  nav: null,
  watchId: null,
  sim: null,
  wakeLock: null,
  follow: true,
  lastFix: null,
  confirmQueue: [],
  confirmTimer: null,
  lastMarked: null,
};

// ================= Mapa =================
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([-15.8, -47.9], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap',
}).addTo(map);
const layers = {
  alts: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  pois: L.layerGroup().addTo(map),
  radars: L.layerGroup().addTo(map),
  me: L.layerGroup().addTo(map),
};
map.on('dragstart', () => { if (S.nav) S.follow = false; });

// Tocar e segurar no mapa (fora da navegação) coloca um radar ali — útil para testes.
map.on('contextmenu', async (e) => {
  if (S.nav) return;
  const v = prompt('Adicionar radar neste ponto?\nLimite de velocidade (km/h) — deixe vazio se não souber:', '');
  if (v === null) return;
  await Radars.add({ lat: e.latlng.lat, lon: e.latlng.lng, limit: parseInt(v, 10) || null, source: 'meu', note: 'colocado no mapa' });
  await drawRadars();
  toast('📷 Radar adicionado.', 2500);
  if (S.trip && $('#tripSummary').innerHTML.trim()) renderSummary(S.trip);
});

function icon(html, cls = 'mk', size = 24) {
  return L.divIcon({ html: `<div class="${cls}">${html}</div>`, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

async function drawRadars() {
  layers.radars.clearLayers();
  const list = await Radars.all();
  for (const r of list) {
    const active = Radars.isActive(r);
    const cls = `mk radar${active ? '' : ' off'}${r.confirmations ? '' : ' pending'}`;
    L.marker([r.lat, r.lon], { icon: icon(r.limit || '📷', cls, 28) })
      .bindPopup(`<b>Radar ${r.limit ? r.limit + ' km/h' : ''}</b><br>${Radars.status(r)}<br>✅ ${r.confirmations} · ❌ ${r.denials}`)
      .addTo(layers.radars);
  }
}

function drawTrip(trip, fit = true) {
  layers.route.clearLayers();
  layers.pois.clearLayers();
  if (!trip) return;
  const line = L.polyline(trip.pts, { color: '#33c3ff', weight: 7, opacity: .9 }).addTo(layers.route);
  L.polyline(trip.pts, { color: '#003b52', weight: 11, opacity: .5 }).addTo(layers.route).bringToBack();
  const s = trip.pts[0], e = trip.pts[trip.pts.length - 1];
  L.marker(s, { icon: icon('🟢') }).addTo(layers.route);
  L.marker(e, { icon: icon('🏁') }).addTo(layers.route);
  for (const p of trip.pois || []) {
    const c = CATEGORIES[p.cat];
    L.marker([p.lat, p.lon], { icon: icon(c.icon) })
      .bindPopup(`<b>${esc(p.name)}</b><br>${c.label}${p.h24 ? ' · 24h' : ''}<br>km ${(p.along / 1000).toFixed(0)} da rota${p.hours && !p.h24 ? '<br>' + esc(p.hours) : ''}`)
      .addTo(layers.pois);
  }
  if (fit) map.fitBounds(line.getBounds(), { padding: [30, 30] });
}

// ================= Navegação entre telas =================
const views = ['v-intro', 'v-plan', 'v-drive', 'v-radars', 'v-music', 'v-settings'];
function show(id) {
  for (const v of views) $('#' + v).hidden = v !== id;
  document.body.classList.toggle('intro', id === 'v-intro');
  document.body.classList.toggle('driving', id === 'v-drive');
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.view === id);
  if (id === 'v-radars') renderRadarList();
  if (id === 'v-music') renderMusic();
  if (id === 'v-settings') renderSettings();
  if (id === 'v-plan') $('#walkWarn').hidden = !S.settings.walkTest;
  setTimeout(() => map.invalidateSize(), 50);
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => show(b.dataset.view);

let toastTimer;
function toast(msg, ms = 5000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
$('#toast').onclick = () => { $('#toast').hidden = true; };

function applyName() {
  for (const el of document.querySelectorAll('[data-appname]')) el.textContent = S.settings.appName;
  document.title = S.settings.appName;
}

// ================= Abertura =================
function greet() {
  const h = new Date().getHours();
  $('#introHello').textContent = h < 5 ? 'Boa viagem, com calma nesta madrugada' : h < 12 ? 'Bom dia, boa viagem' : h < 18 ? 'Boa tarde, boa viagem' : 'Boa noite, boa viagem';
}

$('#btnIntroMusic').onclick = () => trilhaToggle();
$('#btnIntroGo').onclick = () => { Voice.unlock(); show('v-plan'); };

function introHint(text) {
  const el = $('#introNoMusic');
  el.textContent = text || '';
  el.hidden = !text;
}

Music.onChange((st) => {
  const label = st.track ? `${st.playing ? '♪ ' : '⏸ '}${st.track.name}` : '';
  $('#mNow').textContent = st.track ? label : '—';
  $('#mPlay').textContent = st.playing ? '⏸' : '▶';
  for (const li of document.querySelectorAll('#trackList li')) li.classList.toggle('playing', li.dataset.id === st.track?.id && st.playing);
  if (useSpotify()) return;
  $('#introPlaying').textContent = label;
  $('#btnIntroMusic').textContent = st.playing ? '⏸ Pausar a trilha' : '🎷 Tocar a trilha da viagem';
});
Voice.setDucking({ duck: Music.duck, unduck: Music.unduck });

// ================= Trilha: Spotify ou arquivos do celular =================
const useSpotify = () => S.settings.musicSource === 'spotify' && Spotify.connected();
S.sp = { playing: false };

function setSpPlaying(v) {
  S.sp.playing = v;
  $('#spPlay').textContent = v ? '⏸' : '▶';
  if (!useSpotify()) return;
  const name = S.settings.spotifyItem?.name || 'Spotify';
  $('#introPlaying').textContent = `${v ? '♪ ' : '⏸ '}${name} · Spotify`;
  $('#btnIntroMusic').textContent = v ? '⏸ Pausar a trilha' : '🎷 Tocar a trilha da viagem';
}

// Trilha padrão: o artista Nat King Cole.
async function spItem() {
  if (S.settings.spotifyItem) return S.settings.spotifyItem;
  const { artists } = await Spotify.search('Nat King Cole');
  const a = artists.find((x) => /nat king cole/i.test(x.name)) || artists[0];
  if (a) {
    S.settings.spotifyItem = a;
    await saveSettings(S.settings);
    renderSpChoice();
  }
  return a;
}

function spFail(e) {
  const needApp = e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404 || e.status === 403;
  toast('🟢 ' + e.message + (needApp ? ' Abrindo o Spotify…' : ''), 7000);
  if (needApp) window.open(Spotify.openLink(S.settings.spotifyItem), '_blank');
}

async function spStart({ quiet = false } = {}) {
  try {
    await Spotify.play(await spItem());
    setSpPlaying(true);
    setTimeout(spRefresh, 1500);
    return true;
  } catch (e) {
    if (quiet) introHint(`Spotify: ${e.message} Depois toque em “Tocar a trilha”.`);
    else spFail(e);
    return false;
  }
}

async function trilhaToggle() {
  Voice.unlock();
  if (useSpotify()) {
    try {
      if (S.sp.playing) {
        await Spotify.pause();
        setSpPlaying(false);
        return;
      }
      const item = await spItem();
      const pb = await Spotify.playback().catch(() => null);
      if (pb?.context?.uri && pb.context.uri === item?.uri) await Spotify.resume();
      else await Spotify.play(item);
      setSpPlaying(true);
      setTimeout(spRefresh, 1500);
    } catch (e) {
      spFail(e);
    }
    return;
  }
  if (!Music.tracks().length) {
    const msg = 'Nenhuma música configurada. Na aba 🎵 conecte o Spotify ou adicione seus MP3.';
    introHint(msg);
    if (S.nav) toast(msg);
    return;
  }
  Music.toggle();
}

async function spRefresh() {
  if (!Spotify.connected()) return;
  try {
    const pb = await Spotify.playback();
    setSpPlaying(!!pb?.is_playing);
    $('#spNow').textContent = pb?.item ? `♪ ${pb.item.name} — ${(pb.item.artists || []).map((a) => a.name).join(', ')}` : '';
  } catch { /* sem internet: ignora */ }
}

function renderSpChoice() {
  const it = S.settings.spotifyItem;
  $('#spChoice').textContent = it ? `${it.kind === 'artista' ? '🎤' : '📃'} ${it.name}${it.owner ? ' · ' + it.owner : ''}` : '🎤 Nat King Cole (padrão)';
  $('#spOpen').href = Spotify.openLink(it);
}

async function renderMusic() {
  const src = S.settings.musicSource;
  for (const b of document.querySelectorAll('#srcSeg button')) b.classList.toggle('active', b.dataset.src === src);
  $('#srcSpotify').hidden = src !== 'spotify';
  $('#srcLocal').hidden = src !== 'local';
  renderTracks();
  const ok = Spotify.connected();
  $('#spSetup').hidden = ok;
  $('#spConnected').hidden = !ok;
  $('#spRedirect').textContent = Spotify.redirectUri();
  $('#spClientId').value = S.settings.spotifyClientId || '';
  if (!ok) return;
  renderSpChoice();
  spRefresh();
  if (!S.sp.user) {
    try {
      S.sp.user = (await Spotify.me()).display_name || 'você';
    } catch (e) {
      S.sp.user = '';
      if (e.status === 403) toast('🟢 ' + e.message, 7000);
    }
  }
  $('#spUser').textContent = S.sp.user || 'você';
}

for (const b of document.querySelectorAll('#srcSeg button')) {
  b.onclick = async () => {
    if (b.dataset.src === S.settings.musicSource) return;
    if (b.dataset.src === 'spotify') Music.pause();
    else if (S.sp.playing) Spotify.pause().then(() => setSpPlaying(false)).catch(() => {});
    S.settings.musicSource = b.dataset.src;
    await saveSettings(S.settings);
    $('#introPlaying').textContent = '';
    $('#btnIntroMusic').textContent = '🎷 Tocar a trilha da viagem';
    renderMusic();
  };
}

$('#btnCopyRedirect').onclick = async () => {
  try {
    await navigator.clipboard.writeText(Spotify.redirectUri());
    toast('Endereço copiado.', 2000);
  } catch {
    toast('Copie manualmente: ' + Spotify.redirectUri());
  }
};

$('#btnSpConnect').onclick = async () => {
  const id = $('#spClientId').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) return toast('O Client ID tem 32 letras/números. Confira se copiou certo.');
  S.settings.spotifyClientId = id;
  S.settings.musicSource = 'spotify';
  await saveSettings(S.settings);
  Spotify.setClientId(id);
  try {
    await Spotify.login(); // vai para o Spotify e volta para o app
  } catch (e) {
    toast('⚠ ' + e.message);
  }
};

$('#btnSpLogout').onclick = async () => {
  if (!confirm('Desconectar o Spotify deste app?')) return;
  await Spotify.logout();
  S.sp = { playing: false };
  renderMusic();
};

function renderSpResults(items) {
  const ul = $('#spResults');
  ul.innerHTML = items.map((it, i) => `
    <li data-i="${i}">
      ${it.image ? `<img src="${esc(it.image)}" alt="">` : '<span>🎵</span>'}
      <div class="grow"><div class="title">${esc(it.name)}</div><div class="sub">${it.kind === 'artista' ? 'artista' : 'playlist' + (it.owner ? ' de ' + esc(it.owner) : '')}</div></div>
      <button class="btn">Usar</button>
    </li>`).join('') || '<p class="hint">Nada encontrado.</p>';
  for (const li of ul.querySelectorAll('li')) {
    li.querySelector('button').onclick = async () => {
      S.settings.spotifyItem = items[+li.dataset.i];
      await saveSettings(S.settings);
      renderSpChoice();
      ul.innerHTML = '';
      toast(`🎷 Trilha da viagem: ${S.settings.spotifyItem.name}`, 3000);
      spStart();
    };
  }
}

$('#btnSpSearch').onclick = async () => {
  const q = $('#spSearch').value.trim();
  if (!q) return;
  try {
    const { artists, playlists } = await Spotify.search(q);
    renderSpResults([...artists.slice(0, 3), ...playlists]);
  } catch (e) {
    toast('⚠ ' + e.message);
  }
};
$('#spSearch').onkeydown = (e) => { if (e.key === 'Enter') $('#btnSpSearch').click(); };
$('#btnSpMine').onclick = async () => {
  try {
    renderSpResults(await Spotify.myPlaylists());
  } catch (e) {
    toast('⚠ ' + e.message);
  }
};
$('#spPlay').onclick = () => trilhaToggle();
$('#spNext').onclick = () => Spotify.next().then(() => setTimeout(spRefresh, 700)).catch(spFail);
$('#spPrev').onclick = () => Spotify.prev().then(() => setTimeout(spRefresh, 700)).catch(spFail);

// ================= Planejamento =================
function getPosition(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS indisponível'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error('Não foi possível obter a localização: ' + e.message)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000, ...opts },
    );
  });
}

$('#btnMyLoc').onclick = () => { $('#from').value = ''; $('#from').placeholder = 'Minha localização atual'; };

$('#btnAddVia').onclick = () => {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.innerHTML = '<input class="via" placeholder="Passar por (cidade, rodovia, coordenadas…)"><button class="btn icon">✕</button>';
  wrap.querySelector('button').onclick = () => wrap.remove();
  $('#vias').append(wrap);
  wrap.querySelector('input').focus();
};

async function resolvePlace(text, what) {
  const res = await geocode(text);
  if (!res.length) throw new Error(`Não encontrei "${text}" (${what}).`);
  return res[0];
}

$('#btnRoute').onclick = async () => {
  const btn = $('#btnRoute');
  const to = $('#to').value.trim();
  if (!to) return toast('Informe o destino.');
  btn.disabled = true;
  btn.textContent = 'Calculando…';
  $('#routeAlts').innerHTML = '';
  $('#prepareBox').hidden = true;
  $('#tripSummary').innerHTML = '';
  try {
    const fromTxt = $('#from').value.trim();
    const from = fromTxt ? await resolvePlace(fromTxt, 'saída') : { ...(await getPosition()), label: 'Minha localização' };
    const vias = [];
    for (const inp of document.querySelectorAll('#vias .via')) {
      if (inp.value.trim()) vias.push(await resolvePlace(inp.value.trim(), 'parada'));
    }
    const dest = await resolvePlace(to, 'destino');
    S.points = [from, ...vias, dest];
    S.alts = await route(S.points, { foot: S.settings.walkTest });
    S.altIdx = 0;
    renderAlts();
  } catch (e) {
    toast('⚠ ' + e.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Traçar rota';
  }
};

function shortLabel(p) {
  return (p.label || '').split(',')[0];
}

function renderAlts() {
  const box = $('#routeAlts');
  const pts = S.points.map((p, i) => `<div class="sub">${i === 0 ? '🟢' : i === S.points.length - 1 ? '🏁' : '📍'} ${esc(p.label)}</div>`).join('');
  box.innerHTML = `<div class="geo-pick">${pts}</div>` + S.alts.map((a, i) => `
    <div class="alt ${i === S.altIdx ? 'sel' : ''}" data-i="${i}">
      <b>${fmtDist(a.distance)} · ${fmtDur(a.duration)}</b>${i === 0 ? ' <span class="tag">mais rápida</span>' : ''}
      <div class="hint">via ${esc(a.summary || '—')}</div>
    </div>`).join('') +
    (S.alts.length > 1 ? '<p class="hint">Toque para escolher. Quer outro caminho? Use “passar obrigatoriamente por”.</p>' : '');
  for (const el of box.querySelectorAll('.alt')) el.onclick = () => { S.altIdx = +el.dataset.i; renderAlts(); };
  layers.alts.clearLayers();
  S.alts.forEach((a, i) => {
    if (i === S.altIdx) return;
    L.polyline(a.pts, { color: '#8899aa', weight: 5, opacity: .7 }).on('click', () => { S.altIdx = i; renderAlts(); }).addTo(layers.alts);
  });
  const sel = S.alts[S.altIdx];
  drawTrip({ pts: sel.pts, pois: [] });
  $('#prepareBox').hidden = false;
  $('#tripName').value = `${shortLabel(S.points[0])} → ${shortLabel(S.points[S.points.length - 1])}`;
}

$('#btnPrepare').onclick = async () => {
  const sel = S.alts[S.altIdx];
  if (!sel) return;
  const btn = $('#btnPrepare');
  const bar = $('#prepProgress');
  btn.disabled = true;
  btn.textContent = 'Baixando dados da estrada…';
  bar.hidden = false;
  bar.firstElementChild.style.width = '3%';
  const trip = {
    id: uid(),
    name: $('#tripName').value.trim() || 'Viagem',
    created: Date.now(),
    pts: sel.pts,
    distance: sel.distance,
    duration: sel.duration,
    summary: sel.summary,
    steps: sel.steps,
    places: S.points.map((p) => ({ lat: p.lat, lon: p.lon, label: p.label })),
    pois: [],
  };
  try {
    const line = makeLine(sel.pts.map(([lat, lon]) => ({ lat, lon })));
    const { pois, radars } = await fetchAlongRoute(line, S.settings.poiRadius, (f) => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; });
    trip.pois = pois;
    trip.poisOk = true;
    const added = await Radars.mergeOSM(radars);
    if (added) toast(`📷 ${added === 1 ? '1 radar do mapa adicionado' : added + ' radares do mapa adicionados'} à sua base (como “não confirmado”).`, 7000);
  } catch (e) {
    trip.poisOk = false;
    toast('⚠ Não consegui baixar postos/radares agora (' + e.message + '). A rota foi salva; tente “Atualizar dados” depois.', 10000);
  }
  await saveTrip(trip);
  S.trip = trip;
  layers.alts.clearLayers();
  S.alts = [];
  $('#routeAlts').innerHTML = '';
  $('#prepareBox').hidden = true;
  bar.hidden = true;
  btn.disabled = false;
  btn.textContent = '⬇ Preparar viagem offline';
  drawTrip(trip);
  drawRadars();
  await renderSummary(trip);
  renderSavedTrips();
};

async function routeRadarCount(trip) {
  const line = makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon })));
  let n = 0;
  for (const r of await Radars.all()) {
    if (Radars.isActive(r) && locate(line, r, 0, line.pts.length - 1, 45)) n++;
  }
  return n;
}

async function renderSummary(trip) {
  const pois = trip.pois || [];
  const count = (c) => pois.filter((p) => p.cat === c).length;
  const gaps = fuelGaps(pois, trip.distance);
  const big = gaps.filter((g) => g.len > S.settings.fuelGapKm * 1000);
  const nRadar = await routeRadarCount(trip);
  const fuels = pois.filter((p) => p.cat === 'fuel');
  const night = pois.filter((p) => (p.cat === 'fuel' || p.cat === 'food') && p.h24);
  const listItems = (arr) => arr.map((p) => `<li><span>${CATEGORIES[p.cat].icon}</span><div class="grow"><div class="title">${esc(p.name)}${p.h24 ? '<span class="tag h24">24h</span>' : ''}</div><div class="sub">km ${(p.along / 1000).toFixed(0)} · ${p.offset} m da pista</div></div></li>`).join('');
  $('#tripSummary').innerHTML = `
    <div class="summary">
      <h3 style="margin-top:0">${esc(trip.name)}</h3>
      <div class="grid">
        <div><b>${fmtDist(trip.distance)}</b><small>distância</small></div>
        <div><b>${fmtDur(trip.duration)}</b><small>tempo previsto</small></div>
        <div><b>${nRadar}</b><small>radares</small></div>
        <div><b>${count('fuel')}</b><small>⛽ postos</small></div>
        <div><b>${count('food')}</b><small>🍽️ restaurantes</small></div>
        <div><b>${count('rest') + count('lodging')}</b><small>🅿️🛏️ paradas</small></div>
      </div>
      ${trip.poisOk === false ? '<div class="warn">Postos e radares do mapa ainda não foram baixados para esta viagem.</div>' : ''}
      ${big.map((g) => `<div class="warn">⛽ Trecho de <b>${fmtDist(g.len)}</b> sem posto: do km ${(g.from / 1000).toFixed(0)} ao km ${(g.to / 1000).toFixed(0)}. Abasteça antes!</div>`).join('')}
      ${!big.length && fuels.length ? `<div class="hint">Maior trecho sem posto: ${fmtDist(gaps[0].len)}.</div>` : ''}
      <button class="btn primary wide" id="btnStart">▶ Iniciar viagem</button>
      <div class="row wrap" style="margin-top:8px">
        <button class="btn" id="btnSim">🧪 Simular</button>
        <button class="btn" id="btnRefresh">🔄 Atualizar</button>
      </div>
      <details style="margin-top:10px"><summary>⛽ Postos na rota (${fuels.length})</summary><ul class="list">${listItems(fuels)}</ul></details>
      <details><summary>🌙 Abertos 24h (${night.length})</summary><ul class="list">${listItems(night)}</ul></details>
      <details><summary>🍽️ Restaurantes (${count('food')})</summary><ul class="list">${listItems(pois.filter((p) => p.cat === 'food'))}</ul></details>
      <details><summary>🛏️ Paradas e hotéis (${count('rest') + count('lodging')})</summary><ul class="list">${listItems(pois.filter((p) => p.cat === 'rest' || p.cat === 'lodging'))}</ul></details>
    </div>`;
  $('#btnStart').onclick = () => startDrive(trip, false);
  $('#btnSim').onclick = () => startDrive(trip, true);
  $('#btnRefresh').onclick = () => refreshTrip(trip);
}

async function refreshTrip(trip) {
  toast('Atualizando postos e radares…');
  try {
    const line = makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon })));
    const { pois, radars } = await fetchAlongRoute(line, S.settings.poiRadius);
    trip.pois = pois;
    trip.poisOk = true;
    await saveTrip(trip);
    const added = await Radars.mergeOSM(radars);
    toast(`Atualizado: ${pois.length} pontos na rota, ${added} radares novos.`);
    drawTrip(trip, false);
    drawRadars();
    renderSummary(trip);
  } catch (e) {
    toast('⚠ Falhou: ' + e.message);
  }
}

async function renderSavedTrips() {
  const list = await listTrips();
  const ul = $('#savedTrips');
  ul.innerHTML = list.length ? list.map((t) => `
    <li data-id="${t.id}">
      <div class="grow"><div class="title">${esc(t.name)}</div><div class="sub">${fmtDist(t.distance)} · ${fmtDur(t.duration)} · ${new Date(t.created).toLocaleDateString('pt-BR')}</div></div>
      <button class="btn" data-a="open">Abrir</button><button class="btn" data-a="del">🗑</button>
    </li>`).join('') : '<p class="hint">Nenhuma viagem salva ainda.</p>';
  for (const li of ul.querySelectorAll('li')) {
    li.querySelector('[data-a=open]').onclick = async () => {
      const trip = await loadTrip(li.dataset.id);
      S.trip = trip;
      layers.alts.clearLayers();
      drawTrip(trip);
      await renderSummary(trip);
      $('#tripSummary').scrollIntoView({ behavior: 'smooth' });
    };
    li.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm('Apagar esta viagem? (os radares continuam salvos)')) return;
      await deleteTrip(li.dataset.id);
      if (S.trip?.id === li.dataset.id) { S.trip = null; drawTrip(null); $('#tripSummary').innerHTML = ''; }
      renderSavedTrips();
    };
  }
}

$('#btnFree').onclick = () => startDrive(null, false);

// ================= Dirigindo =================
async function startDrive(trip, simulate) {
  Voice.unlock();
  S.follow = true;
  S.nav = new Nav({ trip, radars: await Radars.all(), settings: S.settings, ui: { render, askConfirm, toast } });
  drawTrip(trip, false);
  layers.alts.clearLayers();
  show('v-drive');
  $('#turn').hidden = !trip;
  $('#walkBadge').hidden = !S.settings.walkTest;
  $('#poiStrip').hidden = !trip;
  $('#etaClock').textContent = trip ? '--:--' : 'Só radar';
  $('#etaRem').textContent = trip ? '' : `${(await Radars.all()).filter(Radars.isActive).length} radares na base`;
  requestWakeLock();
  if (simulate && trip) startSim(trip);
  else startGps();
  const nR = S.nav.routeRadars.length;
  Voice.speak(trip ? `Rota fixa carregada. ${nR === 1 ? "1 radar" : nR + " radares"} no caminho. Boa viagem!` : 'Modo alerta de radar ativado. Boa viagem!');
}

function startGps() {
  if (!navigator.geolocation) return toast('GPS indisponível neste aparelho.');
  S.watchId = navigator.geolocation.watchPosition(
    (p) => S.nav?.update({
      lat: p.coords.latitude, lon: p.coords.longitude,
      speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy, time: p.timestamp,
    }),
    (e) => toast('GPS: ' + e.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
}

function startSim(trip) {
  const line = makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon })));
  let along = 0;
  const speed = 27; // ~97 km/h
  const factor = 4; // 4x mais rápido que o real
  toast('🧪 Simulação: o carro anda sozinho pela rota (4x).', 4000);
  S.sim = setInterval(() => {
    along += speed * factor;
    if (along > line.length) { clearInterval(S.sim); S.sim = null; along = line.length; }
    const p = pointAt(line, along);
    S.nav?.update({ lat: p.lat, lon: p.lon, speed, heading: p.heading, time: Date.now() * factor });
  }, 1000);
}

async function requestWakeLock() {
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* sem suporte */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.nav) requestWakeLock();
});

function stopDrive() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  if (S.sim) clearInterval(S.sim);
  S.watchId = S.sim = null;
  S.nav = null;
  S.wakeLock?.release?.();
  S.wakeLock = null;
  layers.me.clearLayers();
  $('#confirmBox').hidden = $('#markBox').hidden = true;
  S.confirmQueue = [];
  show('v-plan');
  drawRadars();
  if (S.trip) { drawTrip(S.trip); renderSummary(S.trip); }
}

$('#btnStop').onclick = () => { if (confirm('Encerrar a navegação?')) stopDrive(); };
$('#btnRecenter').onclick = () => { S.follow = true; if (S.lastFix) map.setView([S.lastFix.lat, S.lastFix.lon], 16); };
$('#btnDriveMusic').onclick = () => trilhaToggle();

let meMarker = null;
function render(st) {
  const f = st.fix;
  S.lastFix = f;
  // velocidade
  $('#spd').textContent = Math.round(st.kmh);
  $('#speedBox').classList.toggle('over', !!st.radar?.over);
  // posição
  const rot = f.heading != null && st.kmh > 3;
  const html = rot ? `<div class="me-arrow" style="transform:rotate(${f.heading}deg)"></div>` : '<div class="me"></div>';
  if (!meMarker) meMarker = L.marker([f.lat, f.lon], { icon: L.divIcon({ html, className: '', iconSize: [22, 28], iconAnchor: [11, 14] }), zIndexOffset: 1000 });
  else meMarker.setIcon(L.divIcon({ html, className: '', iconSize: [22, 28], iconAnchor: [11, 14] }));
  meMarker.setLatLng([f.lat, f.lon]);
  if (!layers.me.hasLayer(meMarker)) layers.me.addLayer(meMarker);
  if (S.follow) map.setView([f.lat, f.lon], S.nav?.walk ? 17 : st.kmh > 80 ? 15 : 16, { animate: false });

  // radar
  const ra = $('#radarAlert');
  if (st.radar) {
    ra.hidden = false;
    ra.classList.toggle('over', !!st.radar.over);
    $('#raDist').textContent = fmtDist(st.radar.d);
    $('#raLimit').textContent = st.radar.r.limit || '!';
  } else ra.hidden = true;

  if (!S.nav?.trip) return;
  // fora da rota
  $('#offRoute').hidden = !st.off;
  if (st.off) $('#offDist').textContent = `(${fmtDist(st.offDist)})`;
  // manobra
  if (st.step) {
    $('#turnArrow').textContent = st.step.arrow;
    $('#turnDist').textContent = fmtDist(st.stepDist);
    $('#turnText').textContent = st.step.text;
  } else if (st.arrived) {
    $('#turnArrow').textContent = '🏁';
    $('#turnDist').textContent = 'Chegou!';
    $('#turnText').textContent = 'Você chegou ao destino';
  }
  // chegada
  $('#etaClock').textContent = fmtClock(new Date(Date.now() + st.remainingSec * 1000));
  $('#etaRem').textContent = `${fmtDist(st.remaining)} · ${fmtDur(st.remainingSec)}`;
  // postos e paradas
  const cards = [];
  const nf = st.next.fuel;
  if (nf[0]) {
    const gap = (nf[1]?.along ?? st.total) - nf[0].along;
    const far = gap > S.settings.fuelGapKm * 1000;
    cards.push(card('⛽ Próximo posto', nf[0], far ? `depois: só em ${fmtDist(gap)}` : (nf[1] ? `seguinte: +${fmtDist(nf[1].d)}` : ''), far));
  } else cards.push('<div class="poi far"><div class="k">⛽ Próximo posto</div><div class="v">nenhum</div><div class="n">até o destino</div></div>');
  if (st.next.food[0]) cards.push(card('🍽️ Comer', st.next.food[0]));
  const rest = [...st.next.rest, ...st.next.lodging].sort((a, b) => a.d - b.d)[0];
  if (rest) cards.push(card(rest.cat === 'lodging' ? '🛏️ Dormir' : '🅿️ Parada', rest));
  $('#poiStrip').innerHTML = cards.join('');
}

function card(k, p, extra = '', far = false) {
  return `<div class="poi ${far ? 'far' : ''}"><div class="k">${k}</div><div class="v">${fmtDist(p.d)}</div>
    <div class="n">${esc(p.name)}${p.h24 ? ' · 24h' : ''} · ${fmtDur(p.sec)}</div>${extra ? `<div class="n" style="color:var(--gold)">${extra}</div>` : ''}</div>`;
}

// ---------- confirmar radar após passar ----------
function askConfirm(r) {
  S.confirmQueue.push(r);
  if (S.confirmQueue.length === 1) nextConfirm();
}

function nextConfirm() {
  const r = S.confirmQueue[0];
  const box = $('#confirmBox');
  if (!r) { box.hidden = true; return; }
  $('#confirmText').textContent = `Passou pelo radar${r.limit ? ' de ' + r.limit + ' km/h' : ''}. Ele estava lá?`;
  box.hidden = false;
  const bar = box.querySelector('.confirm-timer div');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = 'width 15s linear'; bar.style.width = '0%'; }));
  clearTimeout(S.confirmTimer);
  S.confirmTimer = setTimeout(() => answer(null), 15000);
}

async function answer(yes) {
  clearTimeout(S.confirmTimer);
  const r = S.confirmQueue.shift();
  if (r && yes === true) {
    await Radars.confirm(r.id);
    toast('✅ Radar confirmado. Obrigado!', 2500);
  } else if (r && yes === false) {
    await Radars.deny(r.id);
    if (!Radars.isActive(r)) {
      S.nav?.removeRadar(r.id);
      toast('Radar desativado (negado várias vezes).', 3000);
    } else toast('Anotado: não tinha radar.', 2500);
  }
  nextConfirm();
}
$('#btnYes').onclick = () => answer(true);
$('#btnNo').onclick = () => answer(false);

// ---------- marcar radar novo ----------
let markTimer;
$('#btnMark').onclick = async () => {
  const f = S.lastFix;
  if (!f) return toast('Aguardando sinal de GPS…');
  const r = await Radars.add({ lat: f.lat, lon: f.lon, heading: f.speed > 2 ? f.heading : null, source: 'meu' });
  S.lastMarked = r;
  S.nav?.addRadar(r);
  Voice.beep({ times: 1, freq: 660 });
  Voice.speak('Radar marcado.');
  const chips = $('#limitChips');
  chips.innerHTML = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map((v) => `<button class="btn" data-v="${v}">${v}</button>`).join('') + '<button class="btn" data-v="">não sei</button>';
  for (const b of chips.querySelectorAll('button')) {
    b.onclick = async () => {
      if (b.dataset.v) await Radars.update(r.id, { limit: +b.dataset.v });
      $('#markBox').hidden = true;
    };
  }
  $('#markBox').hidden = false;
  clearTimeout(markTimer);
  markTimer = setTimeout(() => { $('#markBox').hidden = true; }, 12000);
};
$('#btnUndoMark').onclick = async () => {
  if (S.lastMarked) {
    if (S.lastMarked.confirmations > 1) await Radars.update(S.lastMarked.id, { confirmations: S.lastMarked.confirmations - 1 });
    else await Radars.remove(S.lastMarked.id);
    S.nav?.removeRadar(S.lastMarked.id);
    S.lastMarked = null;
  }
  $('#markBox').hidden = true;
  toast('Marcação desfeita.', 2000);
};

// ================= Radares =================
async function renderRadarList() {
  const list = await Radars.all();
  const filter = $('#radarFilter').value;
  const conf = list.filter((r) => Radars.status(r) === 'confirmado').length;
  const mine = list.filter((r) => r.source === 'meu').length;
  $('#radarStats').innerHTML = `<div><b>${list.length}</b><small>total</small></div><div><b>${conf}</b><small>confirmados</small></div><div><b>${mine}</b><small>marcados por você</small></div>`;
  let items = list;
  if (filter === 'confirmado' || filter === 'inativo') items = list.filter((r) => Radars.status(r) === filter);
  else if (filter === 'meu' || filter === 'osm') items = list.filter((r) => r.source === filter);
  items = [...items].sort((a, b) => (b.lastSeen || b.created) - (a.lastSeen || a.created)).slice(0, 300);
  const ul = $('#radarList');
  ul.innerHTML = items.map((r) => `
    <li data-id="${r.id}">
      <div class="mk radar ${Radars.isActive(r) ? '' : 'off'}">${r.limit || '?'}</div>
      <div class="grow">
        <div class="title">${r.limit ? r.limit + ' km/h' : 'Limite não informado'} <span class="tag">${Radars.status(r)}</span></div>
        <div class="sub">✅ ${r.confirmations} · ❌ ${r.denials} · ${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}${r.note ? ' · ' + esc(r.note) : ''}</div>
      </div>
      <button class="btn" data-a="map">🗺</button><button class="btn" data-a="edit">✏️</button><button class="btn" data-a="del">🗑</button>
    </li>`).join('') || '<p class="hint">Nenhum radar ainda. Marque com o botão vermelho “+ RADAR” enquanto dirige, ou prepare uma viagem para baixar os do mapa.</p>';
  for (const li of ul.querySelectorAll('li')) {
    const id = li.dataset.id;
    const r = list.find((x) => x.id === id);
    li.querySelector('[data-a=map]').onclick = () => { show('v-plan'); map.setView([r.lat, r.lon], 17); };
    li.querySelector('[data-a=edit]').onclick = async () => {
      const v = prompt('Limite de velocidade (km/h). Deixe vazio se não souber.', r.limit ?? '');
      if (v === null) return;
      const patch = { limit: parseInt(v, 10) || null };
      if (!Radars.isActive(r) && confirm('Reativar este radar?')) { patch.denials = 0; patch.confirmations = Math.max(1, r.confirmations); }
      await Radars.update(id, patch);
      renderRadarList();
      drawRadars();
    };
    li.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm('Apagar este radar?')) return;
      await Radars.remove(id);
      renderRadarList();
      drawRadars();
    };
  }
}
$('#radarFilter').onchange = renderRadarList;
$('#btnRadarMap').onclick = async () => {
  show('v-plan');
  await drawRadars();
  const ls = layers.radars.getLayers();
  if (ls.length) map.fitBounds(L.featureGroup(ls).getBounds(), { padding: [30, 30] });
};

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
$('#btnExportJson').onclick = async () => download(`radares-${stamp()}.json`, Radars.exportJSON(await Radars.all()), 'application/json');
$('#btnExportCsv').onclick = async () => download(`radares-${stamp()}.csv`, Radars.exportCSV(await Radars.all()), 'text/csv');
$('#radarImport').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const items = Radars.parseImport(await file.text(), file.name);
    const n = await Radars.importList(items);
    toast(`📥 ${n} radares importados (${items.length - n} já existiam).`);
    renderRadarList();
    drawRadars();
  } catch (err) {
    toast('⚠ Arquivo não reconhecido: ' + err.message);
  }
  e.target.value = '';
};

// ================= Músicas =================
function renderTracks() {
  const ul = $('#trackList');
  const st = Music.state();
  ul.innerHTML = Music.tracks().map((t, i) => `
    <li data-id="${t.id}" class="${st.track?.id === t.id && st.playing ? 'playing' : ''}">
      <div class="grow" data-a="play"><div class="title">🎵 ${esc(t.name)}</div></div>
      <button class="btn" data-a="del">🗑</button>
    </li>`).join('') || '<p class="hint">Nenhuma música adicionada.</p>';
  Music.tracks().forEach((t, i) => {
    const li = ul.children[i];
    li.querySelector('[data-a=play]').onclick = () => { Voice.unlock(); Music.play(i); };
    li.querySelector('[data-a=del]').onclick = async () => { await Music.removeTrack(t.id); renderTracks(); };
  });
}
$('#musicFiles').onchange = async (e) => {
  await Music.addFiles([...e.target.files]);
  e.target.value = '';
  renderTracks();
  toast(`🎵 ${Music.tracks().length} músicas na trilha.`);
};
$('#mPlay').onclick = () => { Voice.unlock(); Music.toggle(); };
$('#mNext').onclick = () => Music.next();
$('#mPrev').onclick = () => Music.prev();
$('#mShuffle').onclick = () => { Music.shuffle(); renderTracks(); toast('🔀 Ordem embaralhada'); };

// ================= Ajustes =================
function renderSettings() {
  const s = S.settings;
  $('#sName').value = s.appName;
  $('#sVoice').checked = s.voice;
  $('#sBeep').checked = s.beep;
  $('#sIntroMusic').checked = s.introMusic;
  $('#sWalk').checked = s.walkTest;
  $('#sAlert').value = s.alertDist.join(', ');
  $('#sFatigue').value = s.fatigueMin;
  $('#sFuelGap').value = s.fuelGapKm;
  $('#sPoiRadius').value = s.poiRadius;
  navigator.storage?.estimate?.().then((e) => {
    $('#storageInfo').textContent = `Espaço usado pelo app: ${(e.usage / 1048576).toFixed(1)} MB`;
  });
}
$('#btnSaveSettings').onclick = async () => {
  const s = S.settings;
  s.appName = $('#sName').value.trim() || 'Seu Caminho Seguro';
  s.voice = $('#sVoice').checked;
  s.beep = $('#sBeep').checked;
  s.introMusic = $('#sIntroMusic').checked;
  s.walkTest = $('#sWalk').checked;
  const ad = $('#sAlert').value.split(/[,; ]+/).map((x) => parseInt(x, 10)).filter((x) => x >= 50 && x <= 3000);
  if (ad.length) s.alertDist = ad.sort((a, b) => b - a);
  s.fatigueMin = Math.max(30, +$('#sFatigue').value || 120);
  s.fuelGapKm = Math.max(10, +$('#sFuelGap').value || 60);
  s.poiRadius = Math.max(100, +$('#sPoiRadius').value || 400);
  await saveSettings(s);
  Voice.configure(s);
  applyName();
  toast('Ajustes salvos.');
};

// ================= Início =================
async function init() {
  S.settings = await getSettings();
  Voice.configure(S.settings);
  applyName();
  greet();
  await Music.load();
  const spAuth = await Spotify.init(S.settings.spotifyClientId);
  drawRadars();
  renderSavedTrips();
  if (spAuth) {
    // Voltou da tela de autorização do Spotify.
    show('v-music');
    toast(spAuth.ok ? '🟢 Spotify conectado! Escolha a trilha ou toque ▶.' : '⚠ Spotify: ' + spAuth.error, 7000);
  } else {
    show('v-intro');
    // Tenta tocar a trilha na abertura (alguns navegadores só permitem após um toque).
    if (S.settings.introMusic && useSpotify()) {
      spStart({ quiet: true });
    } else if (S.settings.introMusic && Music.tracks().length) {
      const ok = await Music.play();
      if (!ok) document.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#btnIntroMusic')) return;
        if (!Music.state().playing && !$('#v-intro').hidden) Music.play();
      }, { once: true });
    }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();

// Para testes no console.
window.__app = { S, map };
