import { getSettings, saveSettings, listTrips, saveTrip, loadTrip, deleteTrip, uid, kv } from './store.js';
import { geocode, route, cityAt, addressAt } from './routing.js';
import { fetchAlongRoute, fuelGaps, CATEGORIES, lodgingNear, radarsNear, fetchSpeedLimits, tollPlazas } from './pois.js';
import { buildPlan, DEFAULT_PREFS, money } from './planner.js';
import { makeLine, locate, pointAt, fmtDist, fmtDur, fmtClock } from './geo.js';
import * as Radars from './radars.js';
import * as Music from './music.js';
import * as Voice from './voice.js';
import * as Spotify from './spotify.js';
import { Nav } from './nav.js';
import * as Places from './places.js';
import { CONFIG } from './config.js';
import { searchPlaces, suggestPlaces, setSearchKey } from './search.js';
import * as Cities from './cities.js';
import { Mascot, PORTRAIT } from './mascot.js';

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
  presets: new Map(), // texto do campo → lugar já conhecido (favorito, recente)
  pick: null, // escolha de ponto no mapa
  rec: null, // gravador do histórico
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
  places: L.layerGroup().addTo(map),
  track: L.layerGroup().addTo(map),
  rejoin: L.layerGroup().addTo(map),
  me: L.layerGroup().addTo(map),
};
map.on('dragstart', () => { if (S.nav) S.follow = false; });

// Tocar e segurar no mapa (fora da navegação): ir para cá, salvar lugar ou marcar radar.
let menuPoint = null;
map.on('contextmenu', (e) => {
  if (S.nav) return;
  menuPoint = { lat: e.latlng.lat, lon: e.latlng.lng };
  $('#mmWhere').textContent = `📍 ${menuPoint.lat.toFixed(5)}, ${menuPoint.lon.toFixed(5)}`;
  $('#mapMenu').hidden = false;
});
let pickMarker = null;
let pickPt = null;
map.on('click', (e) => {
  if (!S.pick) return;
  pickPt = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (!pickMarker) pickMarker = L.marker(e.latlng, { draggable: true, zIndexOffset: 2000 }).on('dragend', () => { const ll = pickMarker.getLatLng(); pickPt = { lat: ll.lat, lon: ll.lng }; });
  pickMarker.setLatLng(e.latlng).addTo(map);
  $('#pickOk').disabled = false;
});
function endPick(pt) {
  const fn = S.pick;
  S.pick = null;
  document.body.classList.remove('picking');
  $('#pickBanner').hidden = true;
  if (pickMarker) pickMarker.remove();
  setTimeout(() => map.invalidateSize(), 50);
  fn?.(pt);
}
// Escolha de ponto em tela cheia, já com zoom de rua, para achar a porta de casa.
function pickOnMap({ center, text = 'Toque no mapa no ponto exato (dá pra arrastar o alfinete)' } = {}) {
  return new Promise((resolve) => {
    S.pick = resolve;
    pickPt = null;
    $('#pickText').textContent = text;
    $('#pickOk').disabled = true;
    $('#toast').hidden = true;
    document.body.classList.add('picking');
    $('#pickBanner').hidden = false;
    setTimeout(() => {
      map.invalidateSize();
      if (center) {
        map.setView([center.lat, center.lon], 18);
        pickPt = { lat: center.lat, lon: center.lon };
        if (!pickMarker) pickMarker = L.marker([center.lat, center.lon], { draggable: true, zIndexOffset: 2000 }).on('dragend', () => { const ll = pickMarker.getLatLng(); pickPt = { lat: ll.lat, lon: ll.lng }; });
        pickMarker.setLatLng([center.lat, center.lon]).addTo(map);
        $('#pickOk').disabled = false;
      }
    }, 80);
  });
}
$('#pickCancel').onclick = () => endPick(null);
$('#pickOk').onclick = () => endPick(pickPt);
$('#mmCancel').onclick = () => { $('#mapMenu').hidden = true; };
$('#mapMenu').onclick = (e) => { if (e.target.id === 'mapMenu') $('#mapMenu').hidden = true; };
$('#mmGo').onclick = () => {
  $('#mapMenu').hidden = true;
  goTo({ ...menuPoint, label: `Ponto no mapa (${menuPoint.lat.toFixed(4)}, ${menuPoint.lon.toFixed(4)})` });
};
$('#mmSave').onclick = () => {
  $('#mapMenu').hidden = true;
  openPlaceEditor({ kind: 'fav', lat: menuPoint.lat, lon: menuPoint.lon });
};
$('#mmRadar').onclick = async () => {
  $('#mapMenu').hidden = true;
  const v = prompt('Limite de velocidade do radar (km/h) — deixe vazio se não souber:', '');
  if (v === null) return;
  await Radars.add({ lat: menuPoint.lat, lon: menuPoint.lon, limit: parseInt(v, 10) || null, source: 'meu', note: 'colocado no mapa' });
  await drawRadars();
  toast('📷 Radar adicionado.', 2500);
  if (S.trip && $('#tripSummary').innerHTML.trim()) renderSummary(S.trip);
};

// Enquadra no pedaço do mapa que não está coberto pelo painel de baixo.
function fitVisible(bounds) {
  const mapR = $('#map').getBoundingClientRect();
  const plan = $('#v-plan');
  let bottom = 30;
  if (!plan.hidden) bottom = Math.max(30, mapR.bottom - plan.getBoundingClientRect().top + 20);
  map.fitBounds(bounds, { paddingTopLeft: [30, 30], paddingBottomRight: [30, bottom], maxZoom: 17, animate: false });
}

function setPlanCollapsed(on) {
  const plan = $('#v-plan');
  if (on) {
    plan.scrollTop = 0;
    // Altura do painel abaixado = até os atalhos (Casa, Trabalho, 🔍), que continuam visíveis.
    const q = $('#quickPlaces');
    const h = Math.min(q.offsetTop + q.offsetHeight + 14, window.innerHeight * 0.45);
    plan.style.top = `calc(100% - var(--tabs-h) - var(--safe-b) - ${Math.round(h)}px)`;
  } else {
    plan.style.top = '';
  }
  plan.classList.toggle('collapsed', on);
  $('#planHandleText').textContent = on ? 'toque para voltar às opções' : 'toque para ver o mapa';
  setTimeout(() => {
    map.invalidateSize();
    const l = layers.route.getLayers()[0];
    if (l?.getBounds) fitVisible(l.getBounds());
  }, 280);
}
$('#planHandle').onclick = () => setPlanCollapsed(!$('#v-plan').classList.contains('collapsed'));

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
  if (fit) fitVisible(line.getBounds());
}

// ================= Navegação entre telas =================
const views = ['v-intro', 'v-plan', 'v-trip', 'v-places', 'v-cities', 'v-drive', 'v-radars', 'v-music', 'v-settings'];
function show(id) {
  for (const v of views) $('#' + v).hidden = v !== id;
  document.body.classList.toggle('intro', id === 'v-intro');
  document.body.classList.toggle('driving', id === 'v-drive');
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.view === id);
  if (id === 'v-radars') renderRadarList();
  if (id === 'v-music') renderMusic();
  if (id === 'v-settings') renderSettings();
  if (id === 'v-plan') {
    $('#v-plan').classList.remove('collapsed');
    $('#walkWarn').hidden = !S.settings.walkTest;
    renderQuick();
    if (!$('#from').value && (!S.here || Date.now() - S.here.t > 60000)) locateMe({ center: !S.trip });
  }
  if (id === 'v-places') renderPlaces();
  if (id === 'v-cities') renderCityReport();
  if (id === 'v-trip') initTripForm();
  if (id !== 'v-places' && id !== 'v-cities') layers.track.clearLayers();
  if (id === 'v-cities') $('#tabs button[data-view="v-places"]').classList.add('active');
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
    // Sem nada configurado: abre o Nat King Cole direto no app do Spotify.
    toast('🟢 Abrindo o Spotify… dê play lá e volte para cá.', 6000);
    window.open('https://open.spotify.com/search/Nat%20King%20Cole', '_blank');
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
  const fixedId = !!CONFIG.spotifyClientId;
  $('#spEasy').hidden = ok;
  $('#spAdvanced').hidden = ok;
  $('#spConnected').hidden = !ok;
  // Com o Client ID já embutido no app, basta um toque em "Conectar".
  $('#spSteps').hidden = fixedId;
  $('#spClientId').hidden = fixedId;
  $('#btnSpConnect').textContent = fixedId ? '🟢 Conectar Spotify' : '🟢 Autorizar Spotify';
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
  const id = CONFIG.spotifyClientId || $('#spClientId').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) return toast('O Client ID tem 32 letras/números. Confira se copiou certo.');
  if (!CONFIG.spotifyClientId) S.settings.spotifyClientId = id;
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
    if (!navigator.geolocation) return reject(new Error('GPS indisponível neste aparelho.'));
    // Alguns celulares nunca respondem se a permissão ficar "pendurada": trava extra.
    const guard = setTimeout(() => reject(new Error('não consegui sua localização. Confira se a localização está permitida para o app/Safari.')), 20000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(guard);
        S.here = { ...(S.here || {}), lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      (e) => {
        clearTimeout(guard);
        const why = e.code === 1 ? 'a localização está bloqueada. Permita em Ajustes › Privacidade › Serviços de Localização › Safari (ou o app).' : 'não consegui sua localização agora (' + e.message + ').';
        reject(new Error(why));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000, ...opts },
    );
  });
}

// ---------- Saída = onde você está ----------
let hereMarker = null;
let mascot = null; // Kravenox (um só, usado no planejamento e na viagem)
let lastAddrAt = null;
async function locateMe({ center = false } = {}) {
  const box = $('#fromHere');
  try {
    const p = await getPosition({ maximumAge: 15000 });
    box.classList.remove('err');
    if (!S.nav) {
      // Kravenox já aparece aqui (e brinca enquanto você planeja); senão, o ponto azul.
      const krav = (S.settings.carIcon || 'kravenox') === 'kravenox';
      if (krav && !mascot) mascot = new Mascot();
      const icon = krav ? mascot.icon : L.divIcon({ html: '<div class="me"></div>', className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
      if (!hereMarker) hereMarker = L.marker([p.lat, p.lon], { icon, zIndexOffset: 900 });
      else if (hereMarker.options.icon !== icon && (krav || hereMarker.options.icon === mascot?.icon)) hereMarker.setIcon(icon);
      hereMarker.setLatLng([p.lat, p.lon]);
      if (!layers.me.hasLayer(hereMarker)) layers.me.addLayer(hereMarker);
      if (krav) mascot.update({ kmh: 0, mode: S.settings.mascotFun || 'always' });
      if (center) map.setView([p.lat, p.lon], 15);
    }
    // Endereço só se mudou de lugar (economiza consultas).
    if (!lastAddrAt || Math.hypot((p.lat - lastAddrAt.lat) * 111000, (p.lon - lastAddrAt.lon) * 111000) > 80) {
      lastAddrAt = p;
      $('#fromHereText').textContent = `📍 ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      try {
        const addr = await addressAt(p.lat, p.lon);
        if (addr) { S.here.label = addr; $('#fromHereText').textContent = addr; }
      } catch { /* sem internet: fica a coordenada */ }
    } else if (S.here?.label) {
      $('#fromHereText').textContent = S.here.label;
    }
    return S.here;
  } catch (e) {
    box.classList.add('err');
    $('#fromHereText').textContent = '⚠ ' + e.message.charAt(0).toUpperCase() + e.message.slice(1);
    return null;
  }
}

// Texto na saída: vazio = onde você está (mostra o cartão), senão o campo.
function setFrom(text) {
  $('#from').value = text || '';
  $('#fromHere').hidden = !!text;
  $('#fromRow').hidden = !text;
}
$('#btnFromOther').onclick = () => {
  $('#fromHere').hidden = true;
  $('#fromRow').hidden = false;
  $('#from').focus();
};
$('#fromHere').onclick = (e) => { if (e.target.id !== 'btnFromOther' && $('#fromHere').classList.contains('err')) locateMe({ center: true }); };

$('#btnMyLoc').onclick = () => { setFrom(''); locateMe({ center: true }); };

$('#btnAddVia').onclick = () => {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.innerHTML = '<input class="via" placeholder="Passar por (cidade, rodovia, coordenadas…)"><button class="btn icon">✕</button>';
  wrap.querySelector('button').onclick = () => wrap.remove();
  $('#vias').append(wrap);
  wrap.querySelector('input').focus();
};

async function resolvePlace(text, what, boxSel = '#geoResults') {
  const preset = S.presets.get(text);
  if (preset) return preset;
  const fav = await Places.matchFavorite(text);
  if (fav) return { lat: fav.lat, lon: fav.lon, label: `${fav.icon} ${fav.name}` };
  const res = await searchPlaces(text, S.here);
  if (!res.length) throw new Error(`Não encontrei "${text}" (${what}). Tente só o tipo de lugar (ex.: “UPA”, “posto”) para ver os mais perto, inclua o bairro, ou toque e segure no mapa no ponto.`);
  if (res.length === 1) return res[0];
  return chooseResult(res, what, boxSel);
}

// Vários resultados: mostra a lista para o usuário escolher o certo.
function chooseResult(results, what, boxSel = '#geoResults') {
  return new Promise((resolve0, reject0) => {
    const box = $(boxSel);
    const done = (fn, v) => { S.pendingChoose = null; box.innerHTML = ''; fn(v); };
    const resolve = (v) => done(resolve0, v);
    const reject = (e) => done(reject0, e);
    S.pendingChoose = () => reject(new Error('Busca cancelada.'));
    S.onChoosing?.(what);
    box.innerHTML = `<div class="choose-head"><span>Qual ${what}?</span><button class="btn" data-none>✕ Nenhum destes, vou corrigir</button></div>
      <ul class="list geo-pick">${results.map((r, i) =>
      `<li data-i="${i}"><div class="grow"><div class="title">${esc(r.label.split(',')[0])}</div><div class="sub">${esc(r.label.split(',').slice(1).join(',').trim())}</div></div>${r.km != null ? `<span class="tag">${r.km < 10 ? r.km.toFixed(1).replace('.', ',') : Math.round(r.km)} km</span>` : ''}</li>`).join('')}
      <li data-i="-1"><div class="grow sub">✕ Nenhum destes — vou digitar de outro jeito</div></li></ul>`;
    const none = () => {
      reject(new Error('Busca cancelada.'));
      // Volta para o campo com o texto selecionado, pronto para corrigir.
      const plan = boxSel === '#geoResults';
      const field = what === 'saída' ? (plan ? '#from' : '#tpFrom') : what === 'destino' ? (plan ? '#to' : '#tpTo') : null;
      if (field) { $(field).focus(); $(field).select(); }
      toast('Corrija o texto (dica: inclua a cidade) e toque em buscar de novo.', 4000);
    };
    box.querySelector('[data-none]').onclick = none;
    for (const li of box.querySelectorAll('li')) {
      li.onclick = () => {
        const i = +li.dataset.i;
        if (i < 0) none();
        else resolve(results[i]);
      };
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// Começou a corrigir o texto enquanto a lista estava aberta? Some com a lista.
document.addEventListener('input', (e) => {
  if (S.pendingChoose && e.target.matches('#to, #from, .via, #tpTo, #tpFrom, .tp-stop')) S.pendingChoose();
});

// Preenche o destino com um lugar conhecido e já traça a rota a partir de onde você está.
function goTo(place) {
  const text = place.name ? `${place.icon || '📍'} ${place.name}` : place.label;
  S.presets.set(text, { lat: place.lat, lon: place.lon, label: text });
  $('#to').value = text;
  setFrom('');
  $('#vias').innerHTML = '';
  show('v-plan');
  $('#btnRoute').click();
}

$('#btnSwap').onclick = () => {
  const a = $('#from').value || (S.here?.label ? '' : ''), b = $('#to').value;
  setFrom(b);
  $('#to').value = a;
  if (!a) toast('Saída = destino anterior. Agora escolha o novo destino (ou toque em 🏠).', 4000);
};

let routeGen = 0;
function routeBtn(text, busy = true) {
  const btn = $('#btnRoute');
  btn.textContent = text;
  btn.classList.toggle('busy', busy);
}

// Posição atual: usa a que já temos (até 2 min) para não esperar o GPS de novo.
async function hereNow() {
  if (S.here && Date.now() - S.here.t < 120000) return { lat: S.here.lat, lon: S.here.lon, label: 'Minha localização' };
  return { ...(await getPosition()), label: 'Minha localização' };
}

$('#btnRoute').onclick = async () => {
  // Já está buscando? O botão vira "cancelar".
  if (S.routeBusy) {
    routeGen++;
    S.pendingChoose?.();
    S.routeBusy = false;
    routeBtn('Traçar rota', false);
    $('#geoResults').innerHTML = '';
    return;
  }
  const to = $('#to').value.trim();
  if (!to) return toast('Informe o destino.');
  const gen = ++routeGen;
  const alive = () => gen === routeGen;
  S.routeBusy = true;
  S.onChoosing = (what) => routeBtn(`↓ Escolha o ${what} na lista (ou toque para cancelar)`);
  $('#routeAlts').innerHTML = '';
  $('#prepareBox').hidden = true;
  $('#tripSummary').innerHTML = '';
  showRouteBar(null);
  try {
    const fromTxt = $('#from').value.trim();
    routeBtn(fromTxt ? '🔎 Procurando a saída… (toque para cancelar)' : '📍 Pegando sua localização… (toque para cancelar)');
    const from = fromTxt ? await resolvePlace(fromTxt, 'saída') : await hereNow();
    if (!alive()) return;
    const vias = [];
    for (const inp of document.querySelectorAll('#vias .via')) {
      if (!inp.value.trim()) continue;
      routeBtn('🔎 Procurando as paradas… (toque para cancelar)');
      vias.push(await resolvePlace(inp.value.trim(), 'parada'));
      if (!alive()) return;
    }
    routeBtn('🔎 Procurando o destino… (toque para cancelar)');
    const dest = await resolvePlace(to, 'destino');
    if (!alive()) return;
    // Já está no destino (ex.: tocou em Casa estando em casa)?
    const meters = Math.hypot((dest.lat - from.lat) * 111000, (dest.lon - from.lon) * 111000 * Math.cos(from.lat * Math.PI / 180));
    if (!vias.length && meters < 150) {
      const nm = dest.label?.split(',')[0] || 'no destino';
      toast(`📍 Você já está em ${nm} (a ${Math.round(meters)} metros). Não precisa de rota.`, 5000);
      Voice.speak(`Você já está em ${nm.replace(/^[^\p{L}\d]+/u, '')}.`);
      return;
    }
    routeBtn('🛣️ Calculando a rota… (toque para cancelar)');
    const alts = await route([from, ...vias, dest], { foot: S.settings.walkTest });
    if (!alive()) return;
    S.points = [from, ...vias, dest];
    S.alts = alts;
    Places.addRecent(dest).then(renderSuggestions);
    S.altIdx = 0;
    renderAlts();
  } catch (e) {
    if (alive() && e.message !== 'Busca cancelada.') toast('⚠ ' + e.message.charAt(0).toUpperCase() + e.message.slice(1), 9000);
  } finally {
    if (alive()) {
      S.routeBusy = false;
      S.onChoosing = null;
      routeBtn('Traçar rota', false);
    }
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
  // Tocar numa opção: escolhe e abaixa o painel para mostrar a rota no mapa.
  for (const el of box.querySelectorAll('.alt')) el.onclick = () => { S.altIdx = +el.dataset.i; renderAlts(); setPlanCollapsed(true); };
  layers.alts.clearLayers();
  S.alts.forEach((a, i) => {
    if (i === S.altIdx) return;
    L.polyline(a.pts, { color: '#8899aa', weight: 5, opacity: .7 }).on('click', () => { S.altIdx = i; renderAlts(); }).addTo(layers.alts);
  });
  const sel = S.alts[S.altIdx];
  drawTrip({ pts: sel.pts, pois: [] });
  $('#prepareBox').hidden = false;
  $('#tripName').value = `${shortLabel(S.points[0])} → ${shortLabel(S.points[S.points.length - 1])}`;
  showRouteBar({ distance: sel.distance, duration: sel.duration, dest: shortLabel(S.points[S.points.length - 1]) });
}

function tripFromAlt(sel) {
  return {
    id: uid(),
    name: $('#tripName').value.trim() || `${shortLabel(S.points[0])} → ${shortLabel(S.points[S.points.length - 1])}`,
    created: Date.now(),
    pts: sel.pts,
    distance: sel.distance,
    duration: sel.duration,
    summary: sel.summary,
    steps: sel.steps,
    legs: sel.legs,
    places: S.points.map((p) => ({ lat: p.lat, lon: p.lon, label: p.label })),
    pois: [],
  };
}

// Baixa postos, radares e limites do caminho. onProgress(0..1).
async function downloadRouteData(trip, onProgress = () => {}) {
  const line = makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon })));
  const { pois, radars } = await fetchAlongRoute(line, S.settings.poiRadius, (f) => onProgress(f * 0.7));
  trip.pois = pois;
  trip.poisOk = true;
  await loadLimits(trip, line, (f) => onProgress(0.7 + f * 0.3));
  const added = await Radars.mergeOSM(radars);
  await saveTrip(trip);
  return added;
}

function clearAlts() {
  layers.alts.clearLayers();
  S.alts = [];
  $('#routeAlts').innerHTML = '';
  $('#prepareBox').hidden = true;
}

// Barra fixa "6,6 km · 10 min  ▶ Iniciar" (visível até com o painel abaixado).
function showRouteBar(info) {
  const bar = $('#routeBar');
  bar.hidden = !info;
  if ($('#v-plan').classList.contains('collapsed')) setTimeout(() => setPlanCollapsed(true), 0);
  if (!info) return;
  $('#rbMain').textContent = `${info.distance < 1000 ? `${Math.round(info.distance)} metros` : fmtDist(info.distance)} · ${fmtDur(info.duration)}`;
  $('#rbSub').textContent = `até ${info.dest} · chegada ${fmtClock(new Date(Date.now() + info.duration * 1000))}`;
}

// ▶ Iniciar: começa na hora; radares/postos/limites chegam em segundo plano.
$('#btnRouteCancel').onclick = () => {
  clearAlts();
  showRouteBar(null);
  S.trip = null;
  drawTrip(null);
  $('#tripSummary').innerHTML = '';
  $('#to').value = '';
  setPlanCollapsed(false);
  if (S.here) map.setView([S.here.lat, S.here.lon], 15);
};

$('#btnGo').onclick = async () => {
  let trip;
  if (S.alts.length) {
    trip = tripFromAlt(S.alts[S.altIdx]);
    await saveTrip(trip);
    clearAlts();
    S.trip = trip;
    renderSavedTrips();
  } else if (S.trip) {
    trip = S.trip;
  } else return;
  showRouteBar(null);
  await startDrive(trip, false);
  if (trip.poisOk) return;
  try {
    const added = await downloadRouteData(trip);
    if (S.nav?.trip === trip) {
      // Atualiza a navegação em andamento com o que chegou.
      S.nav.pois = trip.pois;
      S.nav.limits = trip.speedLimits || [];
      S.nav.allRadars = await Radars.all();
      S.nav.routeRadars = S.nav.projectRadars(S.nav.allRadars);
      drawTrip(trip, false);
      const n = S.nav.routeRadars.length;
      if (n) toast(`📷 ${n === 1 ? '1 radar' : n + ' radares'} no caminho${added ? ` (${added} novo${added > 1 ? 's' : ''} do mapa)` : ''}. Alertas ativos.`, 5000);
      Voice.speak(n ? `${n === 1 ? 'Um radar' : `${n} radares`} no caminho. Alertas ativos.` : 'Nenhum radar conhecido no caminho.', { force: true });
    }
  } catch {
    trip.poisOk = false;
    toast('⚠ Sem internet para baixar radares do mapa agora — os alertas usam os radares que você já tem.', 7000);
  }
};

$('#btnPrepare').onclick = async () => {
  const sel = S.alts[S.altIdx];
  if (!sel) return;
  const btn = $('#btnPrepare');
  const bar = $('#prepProgress');
  btn.disabled = true;
  btn.textContent = 'Baixando dados da estrada…';
  bar.hidden = false;
  bar.firstElementChild.style.width = '3%';
  const trip = tripFromAlt(sel);
  try {
    const added = await downloadRouteData(trip, (f) => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; });
    if (added) toast(`📷 ${added === 1 ? '1 radar do mapa adicionado' : added + ' radares do mapa adicionados'} à sua base (como “não confirmado”).`, 7000);
  } catch (e) {
    trip.poisOk = false;
    toast('⚠ Não consegui baixar postos/radares agora (' + e.message + '). A rota foi salva; tente “Atualizar dados” depois.', 10000);
  }
  await saveTrip(trip);
  S.trip = trip;
  clearAlts();
  bar.hidden = true;
  btn.disabled = false;
  btn.textContent = '⬇ Salvar e preparar para usar sem internet';
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
  showRouteBar({ distance: trip.distance, duration: trip.duration, dest: (trip.name.split('→')[1] || trip.name).trim() });
  const pois = trip.pois || [];
  const count = (c) => pois.filter((p) => p.cat === c).length;
  const gaps = fuelGaps(pois, trip.distance);
  const big = gaps.filter((g) => g.len > S.settings.fuelGapKm * 1000);
  const nRadar = await routeRadarCount(trip);
  const fuels = pois.filter((p) => p.cat === 'fuel');
  const night = pois.filter((p) => (p.cat === 'fuel' || p.cat === 'food') && p.h24);
  const listItems = (arr) => arr.map((p) => `<li data-pi="${pois.indexOf(p)}"><span>${CATEGORIES[p.cat].icon}</span><div class="grow"><div class="title">${esc(p.name)}${p.h24 ? '<span class="tag h24">24h</span>' : ''}</div><div class="sub">km ${(p.along / 1000).toFixed(0)} · ${p.offset} m da pista</div></div></li>`).join('');
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
        ${trip.plan ? '<button class="btn" id="btnSeePlan">🧭 Roteiro</button>' : ''}
      </div>
      <details style="margin-top:10px"><summary>⛽ Postos na rota (${fuels.length})</summary><ul class="list">${listItems(fuels)}</ul></details>
      <details><summary>🌙 Abertos 24h (${night.length})</summary><ul class="list">${listItems(night)}</ul></details>
      <details><summary>🍽️ Restaurantes (${count('food')})</summary><ul class="list">${listItems(pois.filter((p) => p.cat === 'food'))}</ul></details>
      ${(() => {
        const tl = tollPlazas(applyTollPrices(pois));
        if (!tl.length) return '';
        const tot = tl.reduce((a, t) => a + (t.price ?? tollAvg()), 0);
        return `<details><summary>💰 Pedágios (${tl.length}) · ${tl.some((t) => t.price == null) ? '~' : ''}${moneyBR(tot)}</summary><ul class="list">${tl.map((t, i) => `<li data-tl="${i}"><span>💰</span><div class="grow"><div class="title">${esc(t.name)}${t.freeFlow ? ' (free-flow)' : ''}</div><div class="sub">km ${(t.along / 1000).toFixed(0)} · ${t.price != null ? moneyBR(t.price) : `~${moneyBR(tollAvg())} estimativa — toque para informar`}</div></div></li>`).join('')}</ul></details>`;
      })()}
      <details><summary>🛏️ Paradas e hotéis (${count('rest') + count('lodging')})</summary><ul class="list">${listItems(pois.filter((p) => p.cat === 'rest' || p.cat === 'lodging'))}</ul></details>
    </div>`;
  for (const li of $('#tripSummary').querySelectorAll('li[data-pi]')) li.onclick = () => openPoi(pois[+li.dataset.pi], trip);
  const tlList = tollPlazas(pois);
  for (const li of $('#tripSummary').querySelectorAll('li[data-tl]')) li.onclick = async () => { if (await askTollPrice(tlList[+li.dataset.tl])) renderSummary(trip); };
  $('#btnStart').onclick = () => startDrive(trip, false);
  $('#btnSim').onclick = () => startDrive(trip, true);
  $('#btnRefresh').onclick = () => refreshTrip(trip);
  if (trip.plan) $('#btnSeePlan').onclick = () => { show('v-trip'); renderPlan(trip); };
}

// Limites de velocidade da via: se falhar, a viagem segue sem eles.
async function loadLimits(trip, line, onProgress) {
  try {
    trip.speedLimits = await fetchSpeedLimits(line, onProgress);
  } catch {
    trip.speedLimits = trip.speedLimits || [];
  }
}

async function refreshTrip(trip) {
  toast('Atualizando postos e radares…');
  try {
    const line = makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon })));
    const { pois, radars } = await fetchAlongRoute(line, S.settings.poiRadius);
    trip.pois = pois;
    trip.poisOk = true;
    await loadLimits(trip, line);
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
      <button class="btn" data-a="open">Abrir</button><button class="btn" data-a="back" title="Rota de volta">↩</button><button class="btn" data-a="del">🗑</button>
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
    li.querySelector('[data-a=back]').onclick = async () => {
      const trip = await loadTrip(li.dataset.id);
      const pl = trip.places || [];
      if (pl.length < 2) return toast('Esta viagem não tem os pontos salvos.');
      const a = pl[pl.length - 1], b = pl[0];
      const ta = a.label.split(',')[0], tb = b.label === 'Minha localização' ? 'Ponto de saída da ida' : b.label.split(',')[0];
      S.presets.set(ta, a);
      S.presets.set(tb, b);
      setFrom(ta);
      $('#to').value = tb;
      $('#vias').innerHTML = '';
      $('#btnRoute').click();
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
async function startDrive(trip, simulate, resume = null) {
  Voice.unlock();
  layers.me.clearLayers(); // tira o ponto de "onde você está" do planejamento
  S.rec = null;
  if (!simulate && S.settings.recordDrives) {
    const existing = resume?.driveId ? await Places.loadDrive(resume.driveId) : null;
    S.rec = new Places.DriveRecorder({ tripId: trip?.id || null, name: trip ? trip.name : 'Só radar', existing });
    Places.active.set({ tripId: trip?.id || null, driveId: S.rec.id, name: trip ? trip.name : 'Só radar' });
  }
  S.follow = true;
  S.simulating = !!simulate;
  Cities.resetTrack();
  S.nav = new Nav({ trip, radars: await Radars.all(), settings: S.settings, ui: { render, askConfirm, toast, onStop, onStopEnd } });
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
  if (resume) return Voice.speak('Viagem retomada. A rota continua a mesma.');
  Voice.speak(trip ? departureSpeech(trip, nR) : 'Modo alerta de radar ativado. Boa viagem!', { force: true });
}

// "Saindo agora para Casa. São 6 quilômetros, chegada prevista às 18 e 45…"
function departureSpeech(trip, nR) {
  const dest = trip.places?.length ? trip.places[trip.places.length - 1].label : (trip.name.split('→')[1] || trip.name);
  const name = dest.replace(/^[^\p{L}\d]+/u, '').split(',')[0].trim(); // tira emoji (🏠) e o resto do endereço
  const km = trip.distance / 1000;
  const dist = km < 1 ? `${Math.round(trip.distance / 50) * 50} metros` : `${km < 10 ? Math.round(km) || 1 : Math.round(km)} quilômetro${Math.round(km) === 1 ? '' : 's'}`;
  const eta = new Date(Date.now() + trip.duration * 1000);
  const h = eta.getHours(), m = eta.getMinutes();
  const when = m === 0 ? `às ${h} horas` : `às ${h} e ${m}`;
  const radars = nR ? ` ${nR === 1 ? 'Um radar' : `${nR} radares`} no caminho.` : trip.poisOk ? ' Nenhum radar conhecido no caminho.' : ' Buscando os radares do caminho.';
  const stops = trip.plan?.days?.length > 1 ? ` A viagem tem ${trip.plan.days.length} dias.` : '';
  return `Saindo agora para ${name}. São ${dist}, chegada prevista ${when}.${radars}${stops} Rota fixa, sem desvios. Boa viagem!`;
}

// Sem GPS = sem alerta. Nunca falhar em silêncio: avisa quando o sinal some.
function gpsWatchdog() {
  clearInterval(S.gpsTimer);
  S.lastFixAt = Date.now();
  S.gpsLost = false;
  S.gpsTimer = setInterval(() => {
    if (!S.nav || S.sim) return;
    if (!S.gpsLost && Date.now() - S.lastFixAt > 20000) {
      S.gpsLost = true;
      Voice.beep({ times: 3, freq: 500, force: true });
      Voice.speak('Atenção: sem sinal de GPS. Os alertas de radar estão parados até o sinal voltar.', { force: true });
      toast('📡 Sem sinal de GPS — alertas parados até o sinal voltar. Confira se o app está aberto e a localização permitida.', 15000);
    }
  }, 5000);
}

function gpsOk() {
  S.lastFixAt = Date.now();
  if (S.gpsLost) {
    S.gpsLost = false;
    Voice.speak('Sinal de GPS de volta. Alertas ativos.', { force: true });
    toast('📡 GPS de volta — alertas ativos.', 3000);
  }
}

function startGps() {
  if (!navigator.geolocation) return toast('GPS indisponível neste aparelho.');
  gpsWatchdog();
  S.watchId = navigator.geolocation.watchPosition(
    (p) => gpsOk() || S.nav?.update({
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
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Sem como travar a tela ligada: pede para o usuário ajustar o celular.
    if (!S.warnedScreen) {
      S.warnedScreen = true;
      toast('⚠ Deixe a tela sempre ligada durante a viagem (iPhone: Ajustes › Tela e Brilho › Bloqueio Automático › Nunca). Com a tela apagada os alertas param.', 15000);
    }
  }
}
document.addEventListener('visibilitychange', () => {
  if (!S.nav) return;
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    if (S.hiddenAt && Date.now() - S.hiddenAt > 10000) toast('⚠ Enquanto o app ficou fechado/tela apagada, os alertas ficaram parados. Mantenha o app aberto na tela.', 8000);
  } else {
    S.hiddenAt = Date.now();
  }
});

function stopDrive() {
  if (S.rec) {
    S.rec.finish().then((kept) => { if (kept) toast('📍 Viagem salva no histórico (aba Lugares).', 3500); });
    S.rec = null;
  }
  Places.active.clear();
  $('#resumeBox').hidden = true;
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  if (S.sim) clearInterval(S.sim);
  S.watchId = S.sim = null;
  clearInterval(S.gpsTimer);
  S.nav = null;
  S.wakeLock?.release?.();
  S.wakeLock = null;
  layers.me.clearLayers();
  $('#confirmBox').hidden = $('#markBox').hidden = $('#stopBox').hidden = true;
  $('#stepsPanel').hidden = true;
  $('#arriveCard').hidden = true;
  arriveKeep = false;
  arriveStopSince = 0;
  S.rejoin = null;
  layers.rejoin.clearLayers();
  curStop = null;
  S.confirmQueue = [];
  show('v-plan');
  drawRadars();
  if (S.trip) { drawTrip(S.trip); renderSummary(S.trip); }
}

// Botões do lado ficam sempre logo acima do painel de baixo (que muda de altura).
new ResizeObserver(([e]) => {
  $('#v-drive').style.setProperty('--db-h', `${Math.round(e.target.offsetHeight)}px`);
}).observe($('#v-drive .drive-bottom'));
$('#btnStop').onclick = () => { if (confirm('Encerrar a navegação e salvar no histórico?')) stopDrive(); };
$('#btnRecenter').onclick = () => { S.follow = true; if (S.lastFix) map.setView([S.lastFix.lat, S.lastFix.lon], 16); };
$('#btnDriveMusic').onclick = () => trilhaToggle();

let meMarker = null;
// Ícone do carro: seta grande (padrão), emoji ou uma imagem sua.
const CAR_ICONS = ['arrow', 'kravenox', '🚗', '🚙', '🛻', '🏍️', '🚚', '🦖', '🐉', '🦍'];
let carImage = null;
kv.get('carImage').then((v) => { carImage = v || null; });
function carIcon(heading) {
  const choice = S.settings.carIcon || 'kravenox';
  if (choice === 'custom' && carImage) {
    return L.divIcon({ html: `<div class="car-ico"><img src="${carImage}" alt=""></div>`, className: '', iconSize: [62, 62], iconAnchor: [31, 31] });
  }
  if (choice !== 'arrow' && choice !== 'custom') {
    return L.divIcon({ html: `<div class="car-ico emoji">${choice}</div>`, className: '', iconSize: [44, 44], iconAnchor: [22, 22] });
  }
  const html = heading != null ? `<div class="me-arrow big" style="transform:rotate(${heading}deg)"></div>` : '<div class="me" style="width:30px;height:30px"></div>';
  return L.divIcon({ html, className: '', iconSize: [32, 40], iconAnchor: [16, 20] });
}
function renderCarIcons() {
  const cur = S.settings.carIcon || 'kravenox';
  const face = (c) => c === 'arrow' ? '➤' : c === 'kravenox' ? `<img src="${PORTRAIT}" alt="Kravenox" class="pix" style="width:34px;height:34px">` : c;
  $('#carIcons').innerHTML = CAR_ICONS.map((c) => `<button data-c="${c}" class="${c === cur ? 'sel' : ''}">${face(c)}</button>`).join('') +
    (carImage ? `<button data-c="custom" class="${cur === 'custom' ? 'sel' : ''}"><img src="${carImage}" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover"></button>` : '');
  for (const b of $('#carIcons').querySelectorAll('button')) {
    b.onclick = async () => {
      S.settings.carIcon = b.dataset.c;
      await saveSettings(S.settings);
      renderCarIcons();
      toast('Ícone do carro trocado.', 1500);
    };
  }
}
$('#carImage').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  // Reduz a imagem para 128 px (leve e nítida no mapa).
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode().catch(() => {});
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const side = Math.min(img.naturalWidth, img.naturalHeight) || 128;
  c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
  carImage = c.toDataURL('image/png');
  await kv.set('carImage', carImage);
  S.settings.carIcon = 'custom';
  await saveSettings(S.settings);
  renderCarIcons();
  toast('🦖 Pronto! Seu ícone vai andar pelo mapa.', 3000);
};
let lastActiveSave = 0;
function render(st) {
  const f = st.fix;
  S.lastFix = f;
  if (S.settings.logCities && !S.simulating) Cities.track(f);
  if (S.rec) {
    S.rec.add(f, st.kmh);
    if (Date.now() - lastActiveSave > 60000) {
      lastActiveSave = Date.now();
      Places.active.set({ tripId: S.nav?.trip?.id || null, driveId: S.rec.id, name: S.rec.d.name });
    }
  }
  // velocidade
  $('#spd').textContent = Math.round(st.kmh);
  $('#speedBox').classList.toggle('over', !!(st.radar?.over || st.overRoad));
  $('#limitSign').hidden = !st.roadLimit;
  if (st.roadLimit) $('#limitVal').textContent = st.roadLimit;
  $('#limitNext').hidden = !st.limitDrop;
  if (st.limitDrop) $('#limitNext').textContent = `↓${st.limitDrop.limit} · ${fmtDist(st.limitDrop.d)}`;
  // posição
  const rot = f.heading != null && st.kmh > 3;
  const krav = (S.settings.carIcon || 'kravenox') === 'kravenox';
  if (krav && !mascot) mascot = new Mascot();
  const ico = krav ? mascot.icon : carIcon(rot ? f.heading : null);
  if (!meMarker) meMarker = L.marker([f.lat, f.lon], { icon: ico, zIndexOffset: 1000 });
  else if (!krav || meMarker.options.icon !== ico) meMarker.setIcon(ico);
  meMarker.setLatLng([f.lat, f.lon]);
  if (!layers.me.hasLayer(meMarker)) layers.me.addLayer(meMarker);
  if (krav) {
    // Brincadeiras nunca por cima de avisos: radar, limite, fora da rota ou manobra perto.
    const quiet = !!(st.radar || st.overRoad || st.limitDrop || st.off || (st.stepDist != null && st.stepDist < 400 && st.kmh > 3));
    mascot.update({ kmh: st.kmh, heading: f.heading, arrived: !!st.arrived, quiet, mode: S.settings.mascotFun || 'always' });
  }
  if (S.follow) map.setView([f.lat, f.lon], S.nav?.walk ? 17 : st.kmh > 80 ? 15 : 16, { animate: false });

  // radar
  const ra = $('#radarAlert');
  if (st.radar) {
    ra.hidden = false;
    ra.classList.toggle('over', !!st.radar.over);
    $('#raDist').textContent = fmtDist(st.radar.d);
    $('#raLimit').textContent = st.radar.limit || '!';
  } else ra.hidden = true;

  if (!S.nav?.trip) return;
  // fora da rota
  $('#offRoute').hidden = !st.off;
  if (st.off) {
    $('#offDist').textContent = `(${fmtDist(st.offDist)})`;
    // Seta apontando para o trajeto, relativa para onde o carro está indo.
    const rel = st.backBearing != null ? st.backBearing - (f.heading ?? 0) : 0;
    $('#backArrow').style.transform = `rotate(${rel}deg)`;
  }
  updateRejoin(st, f);
  // manobra
  if (!$('#stepsPanel').hidden) renderSteps(st);
  if (S.rejoin && st.off) {
    // banner mostra o caminho de volta (updateRejoin)
  } else if (st.step) {
    $('#turnArrow').textContent = st.step.arrow;
    $('#turnDist').textContent = fmtDist(st.stepDist);
    $('#turnText').textContent = st.step.type === 'arrive' ? 'até o destino — siga a rota' : st.step.text;
  }
  if (st.arrived) onArrived(st);
  if (st.arrived) {
    $('#turnArrow').textContent = '🏁';
    $('#turnDist').textContent = 'Chegou!';
    $('#turnText').textContent = 'Você chegou ao destino';
  }
  // chegada
  $('#etaClock').textContent = fmtClock(new Date(Date.now() + st.remainingSec * 1000));
  $('#etaRem').textContent = `${fmtDist(st.remaining)} · ${fmtDur(st.remainingSec)}`;
  // postos e paradas
  const cards = [];
  S.cardPois = [];
  if (st.planned) {
    const pl = st.planned;
    const ic = pl.kind === 'pernoite' ? '🛏️' : pl.kind === 'almoço' || pl.kind === 'jantar' ? '🍽️' : '☕';
    const opt = pl.optional ? `<div class="n" style="color:var(--gold)">opcional · você parou ${pl.agoMin ? `há ${pl.agoMin} min` : 'há pouco'}</div>` : '';
    cards.push(`<div class="poi ${pl.optional ? 'optional' : 'far'}"><div class="k">${ic} Parada planejada</div><div class="v">${fmtDist(pl.d)}</div><div class="n">${esc(pl.name)} · ${fmtDur(pl.sec)}</div>${opt}</div>`);
  }
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
  S.cardPois.push(p);
  return `<div class="poi ${far ? 'far' : ''}" data-i="${S.cardPois.length - 1}"><div class="k">${k}</div><div class="v">${fmtDist(p.d)}</div>
    <div class="n">${esc(p.name)}${p.h24 ? ' · 24h' : ''} · ${fmtDur(p.sec)}</div>${extra ? `<div class="n" style="color:var(--gold)">${extra}</div>` : ''}</div>`;
}

// ---------- chegada: cartão "Encerrar" e fim automático ----------
let arriveKeep = false;
let arriveStopSince = 0;
function onArrived(st) {
  if (arriveKeep) return;
  if ($('#arriveCard').hidden) $('#toast').hidden = true; // nada por cima do cartão
  $('#arriveCard').hidden = false;
  if (st.kmh < 5) {
    if (!arriveStopSince) arriveStopSince = Date.now();
    const left = 120 - Math.round((Date.now() - arriveStopSince) / 1000);
    $('#arriveAuto').textContent = left > 0 ? `Encerra sozinho em ${left} s parado.` : 'Encerrando…';
    if (left <= 0) { toast('🏁 Viagem encerrada e salva no histórico.', 4000); stopDrive(); }
  } else {
    arriveStopSince = 0;
    $('#arriveAuto').textContent = 'Encerra sozinho depois de 2 min parado.';
  }
}
$('#btnArriveEnd').onclick = () => stopDrive();
$('#btnArriveKeep').onclick = () => { arriveKeep = true; $('#arriveCard').hidden = true; };

// ---------- caminho de volta para a rota (a rota principal não muda) ----------
async function rejoinRoute() {
  const nav = S.nav, f = S.lastFix;
  if (!nav?.line || !f) return;
  const btn = $('#btnRejoin');
  btn.disabled = true;
  btn.textContent = '🧭 Calculando o caminho de volta…';
  try {
    // Volta num ponto um pouco à frente, para não mandar fazer retorno.
    const loc = locate(nav.line, f);
    const target = pointAt(nav.line, Math.min(nav.line.length, Math.max(loc?.along ?? 0, nav.progress) + 250));
    const [r] = await route([{ lat: f.lat, lon: f.lon }, { lat: target.lat, lon: target.lon }]);
    const line = makeLine(r.pts.map(([lat, lon]) => ({ lat, lon })));
    S.rejoin = { line, steps: r.steps.filter((x) => x.type !== 'depart' && x.type !== 'arrive'), spoken: new Map() };
    layers.rejoin.clearLayers();
    L.polyline(r.pts, { color: '#ff9f1c', weight: 7, dashArray: '10 8' }).addTo(layers.rejoin);
    const first = S.rejoin.steps[0];
    Voice.speak(first ? `Para voltar à rota: ${first.text}.` : 'Siga em frente para voltar à rota.', { force: true });
    toast(`🧭 Caminho de volta: ${fmtDist(r.distance)} (linha laranja).`, 5000);
  } catch (e) {
    toast('⚠ Não consegui calcular o caminho de volta (' + e.message + '). Siga a seta.', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '🧭 Me leve de volta à rota';
  }
}
$('#btnRejoin').onclick = rejoinRoute;

function updateRejoin(st, f) {
  const rj = S.rejoin;
  if (!rj) return;
  if (!st.off) {
    // Voltou para a rota: some a linha laranja.
    S.rejoin = null;
    layers.rejoin.clearLayers();
    return;
  }
  const loc = locate(rj.line, f);
  if (!loc) return;
  const next = rj.steps.find((x) => x.along > loc.along + 10);
  if (!next) return;
  const d = next.along - loc.along;
  $('#turnArrow').textContent = next.arrow;
  $('#turnDist').textContent = fmtDist(d);
  $('#turnText').textContent = `Volta à rota: ${next.text}`;
  const lvl = d < 40 ? 2 : d < 200 ? 1 : 0;
  if (lvl > (rj.spoken.get(next.along) || 0)) {
    rj.spoken.set(next.along, lvl);
    Voice.speak(lvl === 2 ? next.text : `Em ${Math.round(d / 10) * 10} metros, ${next.text.charAt(0).toLowerCase()}${next.text.slice(1)}`, { force: true });
  }
}

// ---------- valores de pedágio que você informou (ficam para as próximas viagens) ----------
let tollPrices = {};
kv.get('tollPrices').then((v) => { tollPrices = v || {}; });
const tollKey = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
const tollAvg = () => S.settings.tripPrefs?.tollAvg ?? 12;
const moneyBR = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;
// Aplica nos pedágios da viagem os valores que você já informou.
function applyTollPrices(pois) {
  for (const p of pois || []) if (p.cat === 'toll' && tollPrices[tollKey(p)] != null) p.price = tollPrices[tollKey(p)];
  return pois;
}
async function askTollPrice(plaza) {
  const cur = tollPrices[tollKey(plaza)] ?? plaza.price;
  const v = prompt(`Quanto custa este pedágio (carro)?\n${plaza.name !== 'Pedágio' ? plaza.name + '\n' : ''}Ex.: 12,40`, cur != null ? String(cur).replace('.', ',') : '');
  if (v === null) return false;
  const n = parseFloat(v.replace(',', '.'));
  if (!(n >= 0)) return false;
  // Guarda para todas as cabines da mesma praça (sentidos/cabines a < 1 km).
  for (const p of (S.nav?.trip?.pois || S.trip?.pois || []).filter((x) => x.cat === 'toll' && Math.abs(x.along - plaza.along) < 1000)) tollPrices[tollKey(p)] = n;
  tollPrices[tollKey(plaza)] = n;
  await kv.set('tollPrices', tollPrices);
  applyTollPrices(S.nav?.trip?.pois || S.trip?.pois);
  toast(`💰 Pedágio salvo: ${moneyBR(n)}. Vale para as próximas viagens.`, 3000);
  return true;
}

// ---------- lista de manobras (tocar no banner verde) ----------
let stepsDrawnAt = -1e9;
function renderSteps(st) {
  const nav = S.nav;
  if (!nav?.line) return;
  const p = st?.progress ?? nav.progress;
  if (st && Math.abs(p - stepsDrawnAt) < 30) return; // não redesenha a cada metro
  stepsDrawnAt = p;
  const avg = nav.trip.distance / nav.trip.duration;
  const tolls = tollPlazas(applyTollPrices(nav.pois)).filter((t) => t.along > p - 10);
  const items = [
    ...nav.steps.filter((s) => s.along > p - 10).map((s) => ({ along: s.along, arrow: s.arrow, text: s.type === 'arrive' ? 'Chegada ao destino' : s.text })),
    ...nav.routeRadars.filter((x) => x.along > p - 10).map((x) => ({ along: x.along, arrow: '📷', radar: true, text: `Radar${(x.r.limit || '') && ` · ${x.r.limit} km/h`}` })),
    ...tolls.map((t) => ({ along: t.along, arrow: '💰', toll: t, text: `Pedágio${t.name && t.name !== 'Pedágio' ? ' ' + t.name : ''}${t.freeFlow ? ' (free-flow, sem cabine)' : ''} · ${t.price != null ? moneyBR(t.price) : `~${moneyBR(tollAvg())} (estimativa — toque para informar)`}` })),
  ].sort((a, b) => a.along - b.along);
  const total = tolls.reduce((a, t) => a + (t.price ?? tollAvg()), 0);
  const guess = tolls.some((t) => t.price == null);
  $('#stepsTolls').textContent = tolls.length ? `💰 ${tolls.length} pedágio${tolls.length > 1 ? 's' : ''} pela frente · ${guess ? '~' : ''}${moneyBR(total)}` : '';
  $('#stepsList').innerHTML = items.length ? items.map((it, i) => `
    <li class="${it.radar ? 'radar' : ''}${it.toll ? 'toll' : ''} ${i === 0 ? 'next' : ''}" ${it.toll ? `data-toll="${i}"` : ''}>
      <span class="st-arrow">${it.arrow}</span>
      <div class="grow"><div class="title">${esc(it.text)}</div><div class="sub">~${fmtDur((it.along - p) / avg)}</div></div>
      <span class="st-d">${fmtDist(Math.max(0, it.along - p))}</span>
    </li>`).join('') : '<p class="hint">Nenhuma manobra pela frente — siga em frente até o destino.</p>';
  for (const li of $('#stepsList').querySelectorAll('[data-toll]')) {
    li.onclick = async () => { if (await askTollPrice(items[+li.dataset.toll].toll)) { stepsDrawnAt = -1e9; renderSteps(); } };
  }
}
$('#turn').onclick = () => {
  const panel = $('#stepsPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { stepsDrawnAt = -1e9; renderSteps(); }
};
$('#stepsClose').onclick = () => { $('#stepsPanel').hidden = true; };

// ---------- confirmar radar após passar ----------
function askConfirm(r) {
  S.rec?.radarPassed();
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
  drawRadars();
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
$('#btnRadarRegion').onclick = async () => {
  const btn = $('#btnRadarRegion');
  btn.disabled = true;
  btn.textContent = 'Baixando…';
  try {
    const pos = await getPosition();
    const list = await radarsNear(pos, 40000);
    const added = await Radars.mergeOSM(list);
    toast(list.length ? `📷 ${list.length === 1 ? '1 radar' : list.length + ' radares'} no mapa da região, ${added} novo${added === 1 ? '' : 's'} na sua base.` : 'O mapa não tem radares cadastrados perto de você. Marque os que encontrar com o botão vermelho!', 7000);
    renderRadarList();
    drawRadars();
  } catch (e) {
    toast('⚠ ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Baixar radares da minha região (40 km)';
  }
};
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
  $('#sTomtom').value = CONFIG.tomtomKey ? '' : (s.tomtomKey || '');
  $('#sTomtom').placeholder = CONFIG.tomtomKey ? '✅ chave já embutida no app' : 'cole aqui a chave da TomTom';
  $('#sVoice').checked = s.voice;
  $('#sBeep').checked = s.beep;
  $('#sIntroMusic').checked = s.introMusic;
  $('#sWalk').checked = s.walkTest;
  $('#sNight').value = s.nightMap;
  $('#sMascotFun').value = s.mascotFun || 'always';
  $('#sRecord').checked = s.recordDrives;
  $('#sCities').checked = s.logCities;
  $('#sSpeedWarn').checked = s.speedWarn !== false;
  $('#sInsist').checked = s.insistent !== false;
  renderVoices();
  renderCarIcons();
  $('#sVoiceRate').value = s.voiceRate || 1.05;
  $('#sRateVal').textContent = `${Number($('#sVoiceRate').value).toFixed(2).replace('.', ',')}×`;
  $('#sAskStop').checked = s.askStopReason;
  $('#sAlert').value = s.alertDist.join(', ');
  $('#sFatigue').value = s.fatigueMin;
  $('#sFuelGap').value = s.fuelGapKm;
  $('#sPoiRadius').value = s.poiRadius;
  navigator.storage?.estimate?.().then((e) => {
    $('#storageInfo').textContent = `Espaço usado pelo app: ${(e.usage / 1048576).toFixed(1)} MB`;
  });
}
// Testa a chave da TomTom procurando um lugar conhecido.
$('#btnTestTomtom').onclick = async () => {
  const key = $('#sTomtom').value.trim() || CONFIG.tomtomKey;
  if (!key) return toast('Cole a chave da TomTom primeiro.', 3000);
  const info = $('#tomtomInfo');
  info.textContent = '🔎 Testando…';
  try {
    const { tomtom } = await import('./routing.js');
    const r = await tomtom("McDonald's", S.here, key, { limit: 3 });
    info.textContent = r.length ? `✅ Funcionou! Ex.: ${r[0].label}. Toque em Salvar.` : '✅ A chave funciona (não achou o exemplo aqui perto). Toque em Salvar.';
  } catch (e) {
    info.textContent = /40[13]/.test(e.message) ? '❌ A TomTom recusou a chave. Confira se copiou inteira (sem espaços).' : '⚠ Não consegui falar com a TomTom agora (internet?). Tente de novo.';
  }
};
$('#btnSaveSettings').onclick = async () => {
  const s = S.settings;
  s.appName = $('#sName').value.trim() || 'Seu Caminho Seguro';
  s.voice = $('#sVoice').checked;
  s.beep = $('#sBeep').checked;
  s.introMusic = $('#sIntroMusic').checked;
  s.walkTest = $('#sWalk').checked;
  s.nightMap = $('#sNight').value;
  s.mascotFun = $('#sMascotFun').value;
  s.recordDrives = $('#sRecord').checked;
  s.logCities = $('#sCities').checked;
  s.speedWarn = $('#sSpeedWarn').checked;
  s.insistent = $('#sInsist').checked;
  s.voiceName = $('#sVoiceName').value;
  s.voiceRate = parseFloat($('#sVoiceRate').value) || 1.05;
  s.tomtomKey = $('#sTomtom').value.trim();
  setSearchKey(s.tomtomKey || CONFIG.tomtomKey);
  s.askStopReason = $('#sAskStop').checked;
  applyNight();
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

// ================= Planejar viagem (roteiro) =================
let tpInit = false;
function initTripForm() {
  if (tpInit) return;
  tpInit = true;
  const d = new Date(Date.now() + 30 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  $('#tpDepart').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const pr = { ...DEFAULT_PREFS, ...(S.settings.tripPrefs || {}) };
  $('#tpMaxH').value = pr.maxDriveH;
  $('#tpKmL').value = pr.kmPerL;
  $('#tpFuel').value = pr.fuelPrice;
  $('#tpToll').value = pr.tollAvg;
  $('#tpNextHour').value = pr.nextDayHour;
}

$('#tpAddStop').onclick = () => {
  const row = document.createElement('div');
  row.className = 'stop-row';
  row.innerHTML = '<input class="tp-stop" placeholder="Cidade (ex.: Registro SP)"><label class="night-toggle"><input type="checkbox" class="tp-night"> 🛏️ dormir</label><button class="btn icon">✕</button>';
  row.querySelector('button').onclick = () => row.remove();
  $('#tpStops').append(row);
  row.querySelector('input').focus();
};

function tpPrefs() {
  const num = (sel, def) => { const v = parseFloat($(sel).value.replace(',', '.')); return isFinite(v) && v > 0 ? v : def; };
  return {
    maxDriveH: num('#tpMaxH', 8),
    breakEveryMin: S.settings.fatigueMin,
    kmPerL: num('#tpKmL', 11),
    fuelPrice: num('#tpFuel', 6.29),
    tollAvg: parseFloat($('#tpToll').value.replace(',', '.')) >= 0 ? parseFloat($('#tpToll').value.replace(',', '.')) : 12,
    nextDayHour: num('#tpNextHour', 8),
  };
}

$('#tpBuild').onclick = async () => {
  const btn = $('#tpBuild');
  const status = (t) => { $('#tpStatus').textContent = t; };
  const toTxt = $('#tpTo').value.trim();
  if (!toTxt) return toast('Informe o destino.');
  btn.disabled = true;
  $('#tpResult').innerHTML = '';
  try {
    status('🔎 Encontrando os lugares…');
    const fromTxt = $('#tpFrom').value.trim();
    S.onChoosing = (what) => status(`↓ Escolha o ${what} na lista abaixo.`);
    const from = fromTxt ? await resolvePlace(fromTxt, 'saída', '#tpGeo') : await hereNow();
    const stops = [];
    for (const row of document.querySelectorAll('#tpStops .stop-row')) {
      const t = row.querySelector('.tp-stop').value.trim();
      if (!t) continue;
      const p = await resolvePlace(t, `parada (${t})`, '#tpGeo');
      stops.push({ ...p, overnight: row.querySelector('.tp-night').checked });
    }
    const dest = await resolvePlace(toTxt, 'destino', '#tpGeo');
    status('🛣️ Calculando a rota…');
    const points = [from, ...stops, dest];
    const sel = (await route(points, { foot: S.settings.walkTest }))[0];
    Places.addRecent(dest);
    const trip = {
      id: uid(),
      name: `${shortLabel(from)} → ${shortLabel(dest)}`,
      created: Date.now(),
      pts: sel.pts, distance: sel.distance, duration: sel.duration, summary: sel.summary,
      steps: sel.steps, legs: sel.legs,
      places: points.map((p) => ({ lat: p.lat, lon: p.lon, label: p.label })),
      stops: stops.map((p) => ({ label: shortLabel(p), overnight: p.overnight, lat: p.lat, lon: p.lon })),
      pois: [],
    };
    status('⛽ Baixando postos, restaurantes, hotéis, pedágios e radares do caminho…');
    try {
      const line = makeLine(sel.pts.map(([lat, lon]) => ({ lat, lon })));
      const { pois, radars } = await fetchAlongRoute(line, S.settings.poiRadius, (f) => status(`⛽ Baixando dados da estrada… ${Math.round(f * 100)}%`));
      trip.pois = pois;
      trip.poisOk = true;
      await Radars.mergeOSM(radars);
      status('🚦 Baixando limites de velocidade das vias…');
      await loadLimits(trip, line, (f) => status(`🚦 Baixando limites de velocidade… ${Math.round(f * 100)}%`));
    } catch (e) {
      trip.poisOk = false;
      toast('⚠ Não consegui baixar os postos agora. O roteiro sai sem sugestões de parada.', 8000);
    }
    const prefs = tpPrefs();
    S.settings.tripPrefs = prefs;
    saveSettings(S.settings);
    applyTollPrices(trip.pois);
    trip.plan = buildPlan(trip, trip.stops, prefs, new Date($('#tpDepart').value || Date.now()));
    await saveTrip(trip);
    S.trip = trip;
    drawTrip(trip);
    drawRadars();
    renderSavedTrips();
    status('');
    renderPlan(trip);
  } catch (e) {
    status('');
    if (e.message !== 'Busca cancelada.') toast('⚠ ' + e.message, 8000);
  } finally {
    btn.disabled = false;
  }
};

const fmtDay = (d) => new Date(d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const hm = (d) => fmtClock(new Date(d));
const mapsLink = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
const kmOf = (a) => `km ${Math.round(a / 1000)}`;

function renderPlan(trip) {
  const plan = trip.plan;
  const t = plan.totals;
  const gaps = fuelGaps(trip.pois || [], trip.distance).filter((g) => g.len > S.settings.fuelGapKm * 1000);
  const warns = [];
  for (const d of plan.days) if (d.night) warns.push(`🌙 Dia ${d.n}: parte do trajeto cai de madrugada (22h–5h). Considere sair mais cedo ou dormir antes.`);
  for (const g of gaps) warns.push(`⛽ Trecho de ${fmtDist(g.len)} sem posto (${kmOf(g.from)} → ${kmOf(g.to)}). Abasteça antes.`);
  if (trip.poisOk === false) warns.push('Postos e restaurantes não foram baixados — as pausas ficaram sem sugestão de lugar.');

  const breakLi = (it) => {
    const title = it.meal ? `${it.meal === 'almoço' || it.meal === 'jantar' ? '🍽️' : '☕'} Pausa para ${it.meal}` : '☕ Pausa';
    if (!it.poi) return `<li class="warnli"><span class="t">${hm(it.time)}</span>${title} <span class="sub">${kmOf(it.along)} · sem posto bom por perto — leve água e lanche</span></li>`;
    const p = it.poi;
    return `<li><span class="t">${hm(it.time)}</span>${title}: <b>${esc(p.name)}</b>${p.h24 ? ' <span class="tag h24">24h</span>' : ''}
      <span class="sub">${CATEGORIES[p.cat].icon} ${CATEGORIES[p.cat].label} · ${kmOf(p.along)}${it.food ? ` · 🍽️ ${esc(it.food.name)} ao lado` : ''} · <a href="${mapsLink(p.lat, p.lon)}" target="_blank" rel="noopener">ver</a></span></li>`;
  };

  const days = plan.days.map((d, di) => {
    const items = d.items.map((it) => it.type === 'city'
      ? `<li><span class="t">${hm(it.time)}</span>📍 Passa por <b>${esc(it.label)}</b> <span class="sub">${kmOf(it.along)} · pausa curta</span></li>`
      : breakLi(it)).join('');
    const tolls = d.tolls.length ? `<li><span class="t">💰</span>${d.tolls.length} pedágio${d.tolls.length > 1 ? 's' : ''} no dia · ~${money(d.tollCost)}</li>` : '';
    let end;
    if (d.end.arrival) end = `<li class="sleep"><span class="t">${hm(d.end.time)}</span>🏁 <b>Chegada ao destino</b></li>`;
    else {
      const name = d.end.label || (d.end.poi ? `perto de ${d.end.poi.name}` : 'cidade a definir');
      end = `<li class="sleep"><span class="t">${hm(d.end.time)}</span>🛏️ <b>Pernoite${d.end.suggested ? ' sugerido' : ''}: <span class="city" data-day="${di}">${esc(name)}</span></b>
        <span class="sub">${kmOf(d.end.along)}${d.end.suggested ? ' · limite de horas ao volante do dia' : ''}</span>
        <div class="hotels" id="hotels-${di}"><button class="btn" data-hotels="${di}">🛏️ Ver hospedagens</button></div></li>`;
    }
    return `<div class="day"><h4>Dia ${d.n} · ${fmtDay(d.start.time)}</h4>
      <div class="sub">${fmtDist(d.distance)} · ${fmtDur(d.driveSec)} dirigindo</div>
      <ul class="tl"><li><span class="t">${hm(d.start.time)}</span>🚗 Saída ${di === 0 ? '' : '(dia seguinte)'}</li>${items}${tolls}${end}</ul></div>`;
  }).join('');

  $('#tpResult').innerHTML = `
    <div class="summary">
      <h3 style="margin-top:0">${esc(trip.name)}</h3>
      <div class="costs">
        <div><b>${fmtDist(t.distance)}</b><small>distância</small></div>
        <div><b>${fmtDur(t.driveSec)}</b><small>dirigindo</small></div>
        <div><b>${plan.days.length}</b><small>${plan.days.length > 1 ? `dias · ${t.nights} noite${t.nights > 1 ? 's' : ''}` : 'dia'}</small></div>
        <div><b>${money(t.fuelCost)}</b><small>⛽ ${Math.round(t.liters)} litros</small></div>
        <div><b>${money(t.tollCost)}</b><small>💰 ${t.plazas} pedágio${t.plazas === 1 ? '' : 's'}*</small></div>
        <div><b>${money(t.fuelCost + t.tollCost)}</b><small>total estrada</small></div>
      </div>
      <p class="hint">* Estimativa: ${t.tollKnown ? `${t.tollKnown} praça(s) com preço do mapa, o resto` : 'cada praça'} pela tarifa média de ${money(plan.prefs.tollAvg)} (ajuste em “Carro e custos”). Pórticos free-flow contam como praça.</p>
      ${warns.map((w) => `<div class="warn">${w}</div>`).join('')}
      <button class="btn primary wide" id="tpStart">▶ Iniciar viagem</button>
      <div class="row wrap" style="margin-top:8px">
        <button class="btn" id="tpMap">🗺 Ver no mapa</button>
        <button class="btn" id="tpRecalc">🔄 Recalcular horários</button>
      </div>
    </div>
    ${days}`;

  $('#tpStart').onclick = () => startDrive(trip, false);
  $('#tpMap').onclick = () => { S.trip = trip; show('v-plan'); drawTrip(trip); renderSummary(trip); };
  $('#tpRecalc').onclick = async () => {
    const prefs = tpPrefs();
    trip.plan = buildPlan(trip, trip.stops || [], prefs, new Date($('#tpDepart').value || Date.now()));
    await saveTrip(trip);
    renderPlan(trip);
    toast('Horários e custos recalculados (a rota é a mesma).', 3000);
  };
  for (const b of $('#tpResult').querySelectorAll('[data-hotels]')) b.onclick = () => showHotels(trip, +b.dataset.hotels);
  nameSuggestedCities(trip);
  $('#tpResult').scrollIntoView({ behavior: 'smooth' });
}

// Descobre o nome da cidade dos pernoites sugeridos (uma consulta por vez).
async function nameSuggestedCities(trip) {
  let changed = false;
  for (const [di, d] of trip.plan.days.entries()) {
    if (d.end.arrival || d.end.label) continue;
    const line = makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon })));
    const pt = pointAt(line, d.end.along);
    d.end.pt = { lat: pt.lat, lon: pt.lon };
    const city = await cityAt(pt.lat, pt.lon);
    if (city) {
      d.end.label = city;
      changed = true;
      const el = document.querySelector(`.city[data-day="${di}"]`);
      if (el) el.textContent = city;
    }
    await new Promise((r) => setTimeout(r, 1100)); // respeita o limite do serviço
  }
  if (changed) saveTrip(trip);
}

async function showHotels(trip, di) {
  const d = trip.plan.days[di];
  const box = $(`#hotels-${di}`);
  let pt = d.end.pt;
  if (!pt) {
    const stop = (trip.stops || []).find((s) => s.overnight && s.label === d.end.label);
    if (stop) pt = { lat: stop.lat, lon: stop.lon };
    else {
      const p = pointAt(makeLine(trip.pts.map(([lat, lon]) => ({ lat, lon }))), d.end.along);
      pt = { lat: p.lat, lon: p.lon };
    }
  }
  box.innerHTML = '<p class="hint">Procurando hospedagens…</p>';
  const city = d.end.label || '';
  const checkin = new Date(d.end.time);
  const checkout = new Date(checkin.getTime() + 86400000);
  const iso = (x) => x.toISOString().slice(0, 10);
  const links = `<div class="links">
    <a class="btn" target="_blank" rel="noopener" href="https://www.booking.com/searchresults.pt-br.html?ss=${encodeURIComponent(city || `${pt.lat},${pt.lon}`)}&checkin=${iso(checkin)}&checkout=${iso(checkout)}&group_adults=2">Booking</a>
    <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/hot%C3%A9is/@${pt.lat},${pt.lon},13z">Google Maps</a>
    <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent('hotel ' + (city || ''))}">Pesquisar</a></div>`;
  try {
    const list = await lodgingNear(pt, 6000);
    box.innerHTML = (list.length ? `<ul class="list">${list.map((h) => `
      <li><div class="grow"><div class="title">${esc(h.name)}${h.stars ? ' ' + '★'.repeat(Math.min(5, h.stars)) : ''}</div>
      <div class="sub">${h.kind} · ${fmtDist(h.d)}${h.phone ? ` · <a href="tel:${esc(h.phone)}">${esc(h.phone)}</a>` : ''}</div></div>
      <a class="btn" target="_blank" rel="noopener" href="${h.site ? esc(h.site) : mapsLink(h.lat, h.lon)}">ver</a></li>`).join('')}</ul>`
      : '<p class="hint">O mapa não tem hospedagens cadastradas aqui. Veja nos sites:</p>') + links;
  } catch {
    box.innerHTML = '<p class="hint">Sem internet para buscar agora. Veja nos sites:</p>' + links;
  }
}

// ================= Lugares, recentes e histórico =================
async function drawPlaces() {
  layers.places.clearLayers();
  for (const p of await Places.favorites()) {
    L.marker([p.lat, p.lon], { icon: icon(p.icon, 'mk place', 28), zIndexOffset: 500 })
      .bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.label)}`)
      .addTo(layers.places);
  }
}

async function renderQuick() {
  const favs = await Places.favorites();
  const home = favs.find((p) => p.kind === 'home');
  const work = favs.find((p) => p.kind === 'work');
  const items = [
    home ? { ...home } : { kind: 'home', icon: '🏠', name: 'Casa', unset: true },
    work ? { ...work } : { kind: 'work', icon: '💼', name: 'Trabalho', unset: true },
    ...favs.filter((p) => p.kind === 'fav'),
  ];
  const box = $('#quickPlaces');
  box.innerHTML = '<button class="btn search" data-i="search">🔍 Para onde?</button>' +
    items.map((p, i) => `<button class="btn ${p.unset ? 'unset' : ''}" data-i="${i}">${p.icon} ${esc(p.name)}${p.unset ? ' +' : ''}</button>`).join('') +
    '<button class="btn unset" data-i="new">＋ Novo</button><button class="btn unset" data-i="edit">✏️ Editar</button>';
  for (const b of box.querySelectorAll('button')) {
    // Tocar e segurar num atalho abre a edição (trocar endereço, apagar).
    let timer = null, long = false;
    b.onpointerdown = () => { long = false; timer = setTimeout(() => { long = true; const p = items[+b.dataset.i]; if (p) openPlaceEditor(p.unset ? { kind: p.kind } : p); }, 600); };
    b.onpointerup = b.onpointerleave = b.onpointercancel = () => clearTimeout(timer);
    b.oncontextmenu = (e) => e.preventDefault();
    b.onclick = () => {
      if (long) return;
      if (b.dataset.i === 'new') return openPlaceEditor({ kind: 'fav' });
      if (b.dataset.i === 'edit') return show('v-places');
      if (b.dataset.i === 'search') { setPlanCollapsed(false); setTimeout(() => $('#to').focus(), 300); return; }
      const p = items[+b.dataset.i];
      if (p.unset) openPlaceEditor({ kind: p.kind });
      else goTo(p);
    };
  }
  renderSuggestions();
}

// Recentes: um toque já traça a rota; tocar e segurar tira da lista.
// Mostra a distância para não confundir dois lugares com o mesmo nome.
async function renderSuggestions() {
  const list = await Places.suggestions(5);
  const box = $('#suggestions');
  const kmTo = (r) => {
    if (!S.here) return '';
    const d = Math.hypot((r.lat - S.here.lat) * 111, (r.lon - S.here.lon) * 111 * Math.cos(r.lat * Math.PI / 180));
    return ` · ${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} km`;
  };
  box.innerHTML = list.map((r, i) => `<button class="btn" data-i="${i}">🕘 <span>${esc(r.label.split(',')[0])}<small>${kmTo(r)}</small></span></button>`).join('');
  for (const b of box.querySelectorAll('button')) {
    const r = list[+b.dataset.i];
    let timer = null, long = false;
    b.onpointerdown = () => {
      long = false;
      timer = setTimeout(async () => {
        long = true;
        if (confirm(`Tirar “${r.label.split(',')[0]}” dos recentes?`)) { await Places.removeRecent(r.id); renderSuggestions(); }
      }, 600);
    };
    b.onpointerup = b.onpointerleave = b.onpointercancel = () => clearTimeout(timer);
    b.oncontextmenu = (e) => e.preventDefault();
    b.onclick = () => {
      if (long) return;
      const text = r.label.split(',')[0];
      S.presets.set(text, { lat: r.lat, lon: r.lon, label: r.label });
      $('#to').value = text;
      setFrom('');
      $('#btnRoute').click();
    };
  }
  updateRecentChips();
}
// Enquanto você digita, os recentes saem da frente das sugestões.
function updateRecentChips() {
  const to = $('#to');
  $('#suggestions').hidden = document.activeElement === to && to.value.trim() !== '';
}
$('#to').addEventListener('input', updateRecentChips);
$('#to').addEventListener('focus', updateRecentChips);
$('#to').addEventListener('blur', () => setTimeout(updateRecentChips, 350));

async function renderPlaces() {
  const favs = await Places.favorites();
  const fl = $('#favList');
  const hasHome = favs.some((p) => p.kind === 'home'), hasWork = favs.some((p) => p.kind === 'work');
  const rows = [
    ...(hasHome ? [] : [{ kind: 'home', icon: '🏠', name: 'Casa', unset: true }]),
    ...(hasWork ? [] : [{ kind: 'work', icon: '💼', name: 'Trabalho', unset: true }]),
    ...favs,
  ].sort((a, b) => ({ home: 0, work: 1 }[a.kind] ?? 2) - ({ home: 0, work: 1 }[b.kind] ?? 2));
  fl.innerHTML = rows.map((p, i) => `
    <li data-i="${i}">
      <div class="place-icon">${p.icon}</div>
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${p.unset ? 'Toque em ✏️ para definir' : esc(p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)}</div></div>
      ${p.unset ? '' : '<button class="btn" data-a="go">🏁</button>'}<button class="btn" data-a="edit">✏️</button>
    </li>`).join('');
  for (const li of fl.querySelectorAll('li')) {
    const p = rows[+li.dataset.i];
    li.querySelector('[data-a=go]')?.addEventListener('click', () => goTo(p));
    li.querySelector('[data-a=edit]').onclick = () => openPlaceEditor(p.unset ? { kind: p.kind } : p);
  }

  const rec = (await Places.recents()).sort((a, b) => Places.score(b) - Places.score(a));
  const rl = $('#recentList');
  rl.innerHTML = rec.length ? rec.slice(0, 20).map((r, i) => `
    <li data-i="${i}">
      <div class="place-icon">🕘</div>
      <div class="grow"><div class="title">${esc(r.label.split(',')[0])}</div><div class="sub">${r.count}× · última: ${new Date(r.last).toLocaleDateString('pt-BR')}</div></div>
      <button class="btn" data-a="go">🏁</button><button class="btn" data-a="fav" title="Salvar como lugar">⭐</button><button class="btn" data-a="del">🗑</button>
    </li>`).join('') : '<p class="hint">Os destinos que você usar aparecem aqui.</p>';
  for (const li of rl.querySelectorAll('li')) {
    const r = rec[+li.dataset.i];
    li.querySelector('[data-a=go]').onclick = () => goTo({ lat: r.lat, lon: r.lon, label: r.label.split(',')[0] });
    li.querySelector('[data-a=fav]').onclick = () => openPlaceEditor({ kind: 'fav', lat: r.lat, lon: r.lon, label: r.label, name: r.label.split(',')[0] });
    li.querySelector('[data-a=del]').onclick = async () => { await Places.removeRecent(r.id); renderPlaces(); };
  }

  renderCityCard();
  const ds = await Places.drives();
  const km = ds.reduce((a, d) => a + d.distance, 0) / 1000;
  const hrs = ds.reduce((a, d) => a + d.movingSec, 0);
  $('#driveStats').innerHTML = `<div><b>${ds.length}</b><small>viagens</small></div><div><b>${Math.round(km).toLocaleString('pt-BR')}</b><small>km rodados</small></div><div><b>${fmtDur(hrs)}</b><small>ao volante</small></div>`;
  const dl = $('#driveList');
  dl.innerHTML = ds.length ? ds.map((d, i) => {
    const dt = new Date(d.start);
    return `<li data-i="${i}">
      <div class="grow"><div class="title">${esc(d.name)}</div>
      <div class="sub">${dt.toLocaleDateString('pt-BR')} ${fmtClock(dt)} · ${fmtDist(d.distance)} · ${fmtDur(d.movingSec)} · máx ${Math.round(d.maxKmh)} km/h${d.radars ? ` · ${d.radars} radar${d.radars > 1 ? 'es' : ''}` : ''}${d.stops ? ` · ${d.stops} parada${d.stops > 1 ? 's' : ''}` : ''}</div></div>
      <button class="btn" data-a="map">🗺</button><button class="btn" data-a="gpx" title="Exportar trajeto (GPX)">📤</button><button class="btn" data-a="del">🗑</button>
    </li>`;
  }).join('') : '<p class="hint">Suas viagens aparecem aqui com o trajeto percorrido (dá pra desligar em Ajustes).</p>';
  for (const li of dl.querySelectorAll('li')) {
    const d = ds[+li.dataset.i];
    li.querySelector('[data-a=map]').onclick = async () => {
      const full = await Places.loadDrive(d.id);
      if (!full?.track?.length) return toast('Trajeto não disponível.');
      layers.track.clearLayers();
      const line = L.polyline(full.track, { color: '#e9b44c', weight: 6, opacity: .9 }).addTo(layers.track);
      L.marker(full.track[0], { icon: icon('🟢') }).addTo(layers.track);
      L.marker(full.track[full.track.length - 1], { icon: icon('🔴') }).addTo(layers.track);
      for (const st of full.stops || []) {
        const r = REASON[st.reason] || { ic: '⏸', t: 'Parada' };
        L.marker([st.lat, st.lon], { icon: icon(r.ic, 'mk', 26) })
          .bindPopup(`<b>${r.t}</b><br>${fmtClock(new Date(st.start))}${st.dur ? ' · ' + fmtDur(st.dur) : ''}${st.place ? '<br>' + esc(st.place) : ''}`)
          .addTo(layers.track);
      }
      // Mostra o mapa por cima da lista por alguns segundos.
      $('#v-places').hidden = true;
      map.invalidateSize();
      map.fitBounds(line.getBounds(), { padding: [30, 30] });
      toast(`${d.name} · ${fmtDist(d.distance)} — toque aqui para voltar à lista`, 30000);
      $('#toast').onclick = () => { $('#toast').hidden = true; $('#toast').onclick = () => { $('#toast').hidden = true; }; show('v-places'); };
    };
    li.querySelector('[data-a=gpx]').onclick = () => exportDriveGpx(d.id);
    li.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm('Apagar esta viagem do histórico?')) return;
      await Places.removeDrive(d.id);
      renderPlaces();
    };
  }
}
$('#btnAddPlace').onclick = () => openPlaceEditor({ kind: 'fav' });
$('#btnClearRecents').onclick = async () => { if (confirm('Limpar destinos recentes?')) { await Places.clearRecents(); renderPlaces(); } };
$('#btnClearDrives').onclick = async () => { if (confirm('Apagar TODO o histórico de viagens?')) { await Places.clearDrives(); renderPlaces(); } };

// ---------- editor de lugar ----------
let pm = null;
function openPlaceEditor(p) {
  const defaults = { home: { name: 'Casa', icon: '🏠' }, work: { name: 'Trabalho', icon: '💼' }, fav: { name: '', icon: '⭐' } }[p.kind || 'fav'];
  pm = { ...defaults, ...p, name: p.name || defaults.name, icon: p.icon || defaults.icon };
  $('#pmTitle').textContent = p.id ? `Editar “${pm.name}”` : p.kind === 'home' ? 'Definir Casa' : p.kind === 'work' ? 'Definir Trabalho' : 'Novo lugar';
  $('#pmName').value = pm.name;
  pm.kind = pm.kind || 'fav';
  for (const b of $('#pmKind').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.k === pm.kind);
    b.onclick = () => {
      pm.kind = b.dataset.k;
      // Ícone acompanha o tipo, se ainda for o padrão.
      if (['⭐', '🏠', '💼'].includes(pm.icon)) {
        pm.icon = { home: '🏠', work: '💼', fav: '⭐' }[pm.kind];
        for (const x of $('#pmIcons').querySelectorAll('button')) x.classList.toggle('sel', x.dataset.ic === pm.icon);
      }
      for (const x of $('#pmKind').querySelectorAll('button')) x.classList.toggle('active', x === b);
    };
  }
  $('#pmCurrent').hidden = !p.id;
  if (p.id) $('#pmCurrent').innerHTML = `📍 Endereço atual: <b>${esc(pm.label || `${pm.lat.toFixed(5)}, ${pm.lon.toFixed(5)}`)}</b><br>Para trocar, busque o novo endereço abaixo ou use “Onde estou agora”.`;
  $('#pmAddrLabel').textContent = p.id ? 'Novo endereço (só se quiser trocar)' : 'Endereço';
  $('#pmAddr').value = '';
  $('#pmNum').value = pm.num || '';
  $('#pmNotExact').hidden = true;
  $('#pmResults').innerHTML = '';
  $('#pmDelete').hidden = !p.id;
  $('#pmIcons').innerHTML = Places.ICONS.map((ic) => `<button data-ic="${ic}" class="${ic === pm.icon ? 'sel' : ''}">${ic}</button>`).join('');
  for (const b of $('#pmIcons').querySelectorAll('button')) {
    b.onclick = () => {
      pm.icon = b.dataset.ic;
      for (const x of $('#pmIcons').querySelectorAll('button')) x.classList.toggle('sel', x === b);
    };
  }
  pmChosen();
  $('#placeModal').hidden = false;
}

function pmChosen() {
  $('#pmChosen').textContent = pm.lat != null ? `✅ ${pm.label || `${pm.lat.toFixed(5)}, ${pm.lon.toFixed(5)}`}` : 'Nenhum ponto escolhido.';
  $('#pmAdjust').hidden = pm.lat == null;
}

async function pmPick(center) {
  pm.name = $('#pmName').value;
  $('#placeModal').hidden = true;
  const pt = await pickOnMap({ center, text: `Toque no ponto exato de “${pm.name || 'seu lugar'}” (ou arraste o alfinete) e confirme` });
  $('#placeModal').hidden = false;
  if (!pt) return;
  Object.assign(pm, pt, { label: 'Ponto marcado no mapa' });
  pmChosen();
  try {
    const addr = await addressAt(pt.lat, pt.lon);
    if (addr) { pm.label = `${addr} (marcado no mapa)`; pmChosen(); }
  } catch { /* sem internet: fica sem o nome da rua */ }
}

async function pmSearch() {
  const q = $('#pmAddr').value.trim();
  if (!q) return;
  try {
    const res = await searchPlaces(q, S.here);
    $('#pmNotExact').hidden = !res.length || res.some((r) => r.full);
    $('#pmNotExact').textContent = '⚠ Não achei exatamente esse endereço — o mapa gratuito não tem todas as ruas e quase nunca tem o número das casas. Escolha a opção mais perto e depois toque em “🎯 Ajustar o ponto exato no mapa”.';
    $('#pmResults').innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}"><div class="grow"><div class="title">${esc(r.label.split(',')[0])}</div><div class="sub">${esc(r.label)}</div></div>${r.km != null ? `<span class="tag">${r.km < 10 ? r.km.toFixed(1).replace('.', ',') : Math.round(r.km)} km</span>` : ''}</li>`).join('') : '<p class="hint">Nada encontrado. Inclua a cidade, ou use “Onde estou agora” / “Escolher no mapa”.</p>';
    for (const li of $('#pmResults').querySelectorAll('li')) {
      li.onclick = () => {
        const r = res[+li.dataset.i];
        Object.assign(pm, { lat: r.lat, lon: r.lon, label: r.label });
        $('#pmResults').innerHTML = '';
        $('#pmNotExact').hidden = true;
        pmChosen();
        toast('Dica: toque em “🎯 Ajustar o ponto exato” para marcar a porta certinha.', 4000);
      };
    }
  } catch (e) {
    toast('⚠ ' + e.message);
  }
}
$('#pmSearch').onclick = pmSearch;
$('#pmAddr').onkeydown = (e) => { if (e.key === 'Enter') pmSearch(); };
$('#pmHere').onclick = async () => {
  try {
    const p = await getPosition({ maximumAge: 5000 });
    Object.assign(pm, p, { label: 'Onde você está agora' });
    pmChosen();
    try {
      const addr = await addressAt(p.lat, p.lon);
      if (addr) { pm.label = addr; pmChosen(); }
    } catch { /* sem internet: fica sem o nome da rua */ }
  } catch (e) {
    toast('⚠ ' + e.message);
  }
};
$('#pmMap').onclick = () => pmPick(pm.lat != null ? pm : S.here || null);
$('#pmAdjust').onclick = () => pmPick(pm);
$('#pmCancel').onclick = () => { $('#placeModal').hidden = true; };
$('#pmSave').onclick = async () => {
  pm.name = $('#pmName').value.trim();
  pm.num = $('#pmNum').value.trim();
  if (pm.num && pm.label && !pm.label.includes(`nº ${pm.num}`)) pm.label = `${pm.label.replace(/ · nº .*$/, '')} · nº ${pm.num}`;
  if (!pm.name) return toast('Dê um nome ao lugar.');
  if (pm.lat == null) return toast('Escolha o endereço, sua localização ou um ponto no mapa.');
  await Places.saveFavorite(pm);
  $('#placeModal').hidden = true;
  toast(`${pm.icon} ${pm.name} salvo.`, 2500);
  drawPlaces();
  renderQuick();
  if (!$('#v-places').hidden) renderPlaces();
};
$('#pmDelete').onclick = async () => {
  if (!confirm(`Apagar “${pm.name}” dos seus lugares?`)) return;
  await Places.removeFavorite(pm.id);
  $('#placeModal').hidden = true;
  drawPlaces();
  renderQuick();
  if (!$('#v-places').hidden) renderPlaces();
};

// ================= Paradas fora do roteiro =================
const REASONS = [
  { k: 'sono', ic: '😴', t: 'Sono / lavar o rosto', cls: 'sono' },
  { k: 'banheiro', ic: '🚻', t: 'Banheiro' },
  { k: 'cafe', ic: '☕', t: 'Café / lanche' },
  { k: 'refeicao', ic: '🍽️', t: 'Refeição' },
  { k: 'abastecer', ic: '⛽', t: 'Abastecer' },
  { k: 'passeio', ic: '📸', t: 'Passeio / foto' },
  { k: 'outro', ic: '📍', t: 'Outro' },
];
const REASON = Object.fromEntries(REASONS.map((r) => [r.k, r]));
REASON[''] = { ic: '🅿️', t: 'Parada' };
REASON['check-in'] = { ic: '📍', t: 'Check-in' };
let curStop = null;

$('#stopReasons').innerHTML = REASONS.map((r) => `<button class="btn ${r.cls || ''}" data-k="${r.k}">${r.ic} ${r.t}</button>`).join('');
for (const b of $('#stopReasons').querySelectorAll('button')) b.onclick = () => registerStop(curStop, b.dataset.k);

function onStop(st) {
  if (!S.settings.askStopReason) return registerStop(st, '', { quiet: true });
  openStopBox(st);
}

function openStopBox(st) {
  curStop = st;
  $('#stopText').textContent = st.auto ? '🅿️ Parou? Qual o motivo?' : '☕ Registrar parada — qual o motivo?';
  $('#stopBox').hidden = false;
  Voice.beep({ times: 1, freq: 520 });
}

// Nome do lugar: o posto/restaurante da rota mais perto (até 300 m).
function placeName(pt) {
  let best = null, bd = 300;
  for (const p of S.nav?.trip?.pois || []) {
    const d = Math.hypot((p.lat - pt.lat) * 111000, (p.lon - pt.lon) * 111000 * Math.cos(pt.lat * Math.PI / 180));
    if (d < bd) { bd = d; best = p; }
  }
  return best ? best.name : '';
}

function registerStop(st, reason, { quiet = false } = {}) {
  if (!st) return;
  $('#stopBox').hidden = true;
  curStop = null;
  st.reason = reason;
  if (st.recId) S.rec?.updateStop(st.recId, { reason });
  else if (S.rec) st.recId = S.rec.addStop({ ...st, reason, place: placeName(st) }).id;
  if (S.settings.logCities && !S.simulating && !st.cityLogged) {
    st.cityLogged = true;
    Cities.markStop(st, reason);
  }
  if (reason === 'sono') {
    S.nav?.rested();
    Voice.speak('Descanso registrado. Lave o rosto, tome uma água e só volte quando estiver bem.');
    toast('😴 Descanso registrado — contador de cansaço zerado.', 5000);
  } else if (!quiet) {
    toast(`${REASON[reason]?.ic || '⏸'} Parada registrada.`, 2500);
  }
}

function onStopEnd(st, dur) {
  if (curStop === st) {
    // Não respondeu: registra só se foi uma parada de verdade (5 min+).
    $('#stopBox').hidden = true;
    curStop = null;
    if (dur >= 300) registerStop(st, '', { quiet: true });
  }
  if (st.recId) S.rec?.updateStop(st.recId, { dur });
}

$('#btnStopTraffic').onclick = () => { $('#stopBox').hidden = true; curStop = null; };
$('#btnPause').onclick = () => {
  const st = S.nav?.manualStop();
  if (!st) return toast('Aguardando sinal de GPS…');
  openStopBox(st);
};

// ================= Diário de cidades =================
async function renderCityCard() {
  const list = await Cities.all();
  const st = Cities.stats(list);
  $('#cityStats').innerHTML = `<div><b>${st.cities}</b><small>cidades</small></div><div><b>${st.states}</b><small>estados</small></div><div><b>${st.stopped}</b><small>onde parou</small></div>`;
  const pend = await Cities.pending();
  $('#cityPending').textContent = pend ? `⏳ ${pend} ponto(s) aguardando internet para descobrir a cidade.` : (list.length ? '' : 'As cidades aparecem aqui conforme você viaja com o app aberto.');
}

const UF_NAMES = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
const fmtDate = (t) => new Date(t).toLocaleDateString('pt-BR');

function cityRow(c) {
  const reasons = Object.keys(c.reasons || {}).map((k) => REASON[k]?.ic).filter(Boolean).join('');
  return `<li class="city-row" data-key="${esc(c.key)}">
    <div class="grow"><div class="title">${esc(c.city)} <span class="badges">${c.stopped ? '🛑' : '🚗'}${reasons}</span></div>
    <div class="sub">${c.stopped ? `parou ${c.stops}×` : 'passou'} · ${c.days.length} dia${c.days.length > 1 ? 's' : ''} · ${c.first === c.last || fmtDate(c.first) === fmtDate(c.last) ? fmtDate(c.first) : `${fmtDate(c.first)} → ${fmtDate(c.last)}`}</div></div>
    <button class="btn" data-a="del">🗑</button></li>`;
}

async function renderCityReport() {
  const list = await Cities.all();
  const st = Cities.stats(list);
  $('#crStats').innerHTML = `<div><b>${st.cities}</b><small>cidades</small></div><div><b>${st.states}</b><small>estados</small></div><div><b>${st.stopped}</b><small>onde parou</small></div>`;
  const sort = $('#crSort').value;
  let html = '';
  if (!list.length) html = '<p class="hint">Nenhuma cidade ainda. Elas são registradas sozinhas enquanto você dirige com o app aberto — ou toque em “📍 Estou aqui”.</p>';
  else if (sort === 'state') {
    const groups = {};
    for (const c of list) (groups[c.uf || c.state || c.country] ||= []).push(c);
    html = Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([uf, cs]) =>
      `<div class="state-group"><h4><span class="uf">${esc(uf)}</span>${esc(UF_NAMES[uf] || cs[0].state || '')} <small class="sub">· ${cs.length} cidade${cs.length > 1 ? 's' : ''}</small></h4>
       <ul class="list">${cs.sort((a, b) => a.city.localeCompare(b.city, 'pt-BR')).map(cityRow).join('')}</ul></div>`).join('');
  } else {
    const arr = [...list].sort(sort === 'recent' ? (a, b) => b.last - a.last : (a, b) => b.days.length + b.stops - (a.days.length + a.stops));
    html = `<ul class="list">${arr.map((c) => cityRow({ ...c, city: `${c.city} (${c.uf || c.state})` })).join('')}</ul>`;
  }
  $('#crList').innerHTML = html;
  for (const li of $('#crList').querySelectorAll('li')) {
    li.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm('Remover esta cidade do diário?')) return;
      await Cities.remove(li.dataset.key);
      renderCityReport();
    };
  }
}

$('#crSort').onchange = renderCityReport;
$('#btnCityReport').onclick = () => show('v-cities');
$('#btnCitiesBack').onclick = () => show('v-places');
$('#btnCheckIn').onclick = async () => {
  try {
    const p = await getPosition({ maximumAge: 10000 });
    Cities.checkIn(p);
    toast('📍 Anotado! A cidade aparece no diário em instantes (ou quando houver internet).', 4000);
  } catch (e) {
    toast('⚠ ' + e.message);
  }
};
$('#btnCitiesMap').onclick = async () => {
  const list = await Cities.all();
  if (!list.length) return toast('Nenhuma cidade ainda.');
  layers.track.clearLayers();
  for (const c of list) {
    L.marker([c.lat, c.lon], { icon: icon('', `mk city${c.stopped ? '' : ' passed'}`, 14) })
      .bindPopup(`<b>${esc(c.city)}/${esc(c.uf || c.state)}</b><br>${c.stopped ? `parou ${c.stops}×` : 'passou'} · ${c.days.length} dia(s)`)
      .addTo(layers.track);
  }
  $('#v-cities').hidden = true;
  map.invalidateSize();
  map.fitBounds(L.featureGroup(layers.track.getLayers()).getBounds(), { padding: [40, 40], maxZoom: 11 });
  toast(`🏙️ ${list.length} cidades — toque aqui para voltar ao relatório`, 30000);
  $('#toast').onclick = () => { $('#toast').hidden = true; $('#toast').onclick = () => { $('#toast').hidden = true; }; show('v-cities'); };
};
$('#btnCitiesShare').onclick = async () => {
  const list = await Cities.all();
  const st = Cities.stats(list);
  const groups = {};
  for (const c of list) (groups[c.uf || c.state] ||= []).push(c.city);
  const text = `🏙️ Já conheci ${st.cities} cidades em ${st.states} estado${st.states > 1 ? 's' : ''}!\n\n` +
    Object.entries(groups).map(([uf, cs]) => `${uf}: ${cs.sort((a, b) => a.localeCompare(b, 'pt-BR')).join(', ')}`).join('\n') + `\n\n— ${S.settings.appName}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Texto copiado!'); }
  } catch { /* cancelado */ }
};
$('#btnCitiesImport').onclick = async () => {
  const metas = await Places.drives();
  const full = [];
  for (const m of metas) full.push(await Places.loadDrive(m.id));
  const n = await Cities.importTracks(full);
  toast(n ? `🔎 ${n} pontos das viagens antigas na fila. As cidades vão aparecendo (1 por segundo, precisa de internet).` : 'Nenhuma viagem gravada no histórico ainda.', 7000);
  renderCityReport();
};
$('#btnCitiesClear').onclick = async () => {
  if (!confirm('Apagar todo o diário de cidades?')) return;
  await Cities.clear();
  renderCityReport();
};
Cities.onChange(() => {
  if (!$('#v-places').hidden) renderCityCard();
  if (!$('#v-cities').hidden) renderCityReport();
});

// ================= Detalhes de posto / restaurante / parada =================
let pdPoi = null;
function openPoi(p, trip = S.nav?.trip) {
  if (!p) return;
  pdPoi = p;
  const c = CATEGORIES[p.cat] || { icon: '📍', label: '' };
  $('#pdTitle').textContent = `${c.icon} ${p.name}`;
  const lines = [`<div class="pd-line">${c.label}${p.brand && p.brand !== p.name ? ' · ' + esc(p.brand) : ''}</div>`];
  if (p.d != null) lines.push(`<div class="pd-line">📏 ${fmtDist(p.d)} à frente · ~${fmtDur(p.sec)}</div>`);
  else if (p.along != null) lines.push(`<div class="pd-line">📏 km ${Math.round(p.along / 1000)} da rota${trip ? ` (de ${Math.round(trip.distance / 1000)} km)` : ''}</div>`);
  if (p.offset != null) lines.push(`<div class="pd-line">↔ ${p.offset} m da pista</div>`);
  lines.push(`<div class="pd-line">🕘 ${p.h24 ? '<span class="tag h24">Aberto 24h</span>' : p.hours ? esc(p.hours) : 'Horário não informado no mapa'}</div>`);
  if (p.phone) lines.push(`<div class="pd-line">📞 ${esc(p.phone)}</div>`);
  if (p.cat === 'toll') lines.push(`<div class="pd-line">💰 ${p.price ? 'R$ ' + p.price.toFixed(2).replace('.', ',') : 'preço não informado no mapa'}${p.freeFlow ? ' · free-flow (sem cabine)' : ''}</div>`);
  $('#pdBody').innerHTML = lines.join('');
  $('#pdGmaps').href = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
  $('#pdCall').hidden = !p.phone;
  if (p.phone) $('#pdCall').href = 'tel:' + p.phone.replace(/[^\d+]/g, '');
  $('#poiModal').hidden = false;
}
$('#pdClose').onclick = () => { $('#poiModal').hidden = true; };
$('#poiModal').onclick = (e) => { if (e.target.id === 'poiModal') $('#poiModal').hidden = true; };
$('#pdMap').onclick = () => {
  $('#poiModal').hidden = true;
  if (!S.nav) {
    show('v-plan');
    $('#v-plan').scrollTop = 0;
  } else {
    S.follow = false;
    toast('Toque 🎯 para voltar a seguir o carro.', 4000);
  }
  map.setView([pdPoi.lat, pdPoi.lon], 16);
  L.popup().setLatLng([pdPoi.lat, pdPoi.lon]).setContent(`<b>${esc(pdPoi.name)}</b>`).openOn(map);
};
$('#poiStrip').onclick = (e) => {
  const el = e.target.closest('.poi[data-i]');
  if (el) openPoi(S.cardPois?.[+el.dataset.i]);
};

// ================= Exportar histórico e backup completo =================
function csvCell(v) {
  const t = String(v ?? '');
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

$('#btnExportDrives').onclick = async () => {
  const metas = await Places.drives();
  if (!metas.length) return toast('Nenhuma viagem no histórico ainda.');
  const rows = [['data', 'saida', 'chegada', 'viagem', 'km', 'tempo_ao_volante_min', 'vel_max_kmh', 'radares', 'paradas', 'motivos_das_paradas'].join(';')];
  for (const m of metas) {
    const d = await Places.loadDrive(m.id);
    const reasons = (d?.stops || []).map((x) => (REASON[x.reason] || REASON['']).t).join(', ');
    rows.push([
      new Date(m.start).toLocaleDateString('pt-BR'), fmtClock(new Date(m.start)), fmtClock(new Date(m.end)), m.name,
      (m.distance / 1000).toFixed(1).replace('.', ','), Math.round(m.movingSec / 60), Math.round(m.maxKmh), m.radars || 0, m.stops || 0, reasons,
    ].map(csvCell).join(';'));
  }
  // BOM para o Excel abrir os acentos certinho.
  download(`historico-viagens-${stamp()}.csv`, '﻿' + rows.join('\n'), 'text/csv');
};

// GPX de uma viagem (abre no Google Earth, Strava, etc.)
async function exportDriveGpx(id) {
  const d = await Places.loadDrive(id);
  if (!d?.track?.length) return toast('Trajeto não disponível.');
  const x = (t) => String(t).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const wpts = (d.stops || []).map((st) => `<wpt lat="${st.lat}" lon="${st.lon}"><time>${new Date(st.start).toISOString()}</time><name>${x((REASON[st.reason] || REASON['']).t)}</name></wpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${x(S.settings.appName)}" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${x(d.name)}</name><time>${new Date(d.start).toISOString()}</time></metadata>
${wpts}
<trk><name>${x(d.name)}</name><trkseg>
${d.track.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join('\n')}
</trkseg></trk>
</gpx>`;
  download(`viagem-${new Date(d.start).toISOString().slice(0, 10)}.gpx`, gpx, 'application/gpx+xml');
}

const BACKUP_KEYS = ['settings', 'radars', 'places', 'recents', 'drives', 'cities', 'cityQueue', 'trips'];
$('#btnBackup').onclick = async () => {
  const data = {};
  for (const k of BACKUP_KEYS) data[k] = await kv.get(k);
  for (const t of data.trips || []) data['trip:' + t.id] = await kv.get('trip:' + t.id);
  for (const d of data.drives || []) data['drive:' + d.id] = await kv.get('drive:' + d.id);
  const json = JSON.stringify({ app: 'seu-caminho-seguro', kind: 'backup', version: 1, created: new Date().toISOString(), data });
  download(`backup-caminho-seguro-${stamp()}.json`, json, 'application/json');
  toast('💾 Backup salvo. Guarde o arquivo (ex.: no iCloud Drive / Google Drive).', 6000);
};
$('#restoreFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const b = JSON.parse(await file.text());
    if (b.kind !== 'backup' || !b.data) throw new Error('não é um backup deste app');
    if (!confirm(`Restaurar o backup de ${new Date(b.created).toLocaleString('pt-BR')}? Os dados atuais deste celular serão substituídos.`)) return;
    for (const [k, v] of Object.entries(b.data)) if (v != null) await kv.set(k, v);
    toast('✅ Backup restaurado. Reabrindo…', 2500);
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    toast('⚠ Arquivo inválido: ' + err.message);
  }
};

// ================= Sugestões enquanto digita =================
const fmtKm = (k) => (k == null ? '' : k < 10 ? `${k.toFixed(1).replace('.', ',')} km` : `${Math.round(k)} km`);
function attachSuggest(inputSel, onPick) {
  const inp = $(inputSel);
  const box = document.createElement('ul');
  box.className = 'list suggest';
  box.hidden = true;
  (inp.closest('.row') || inp).after(box);
  let timer = null, seq = 0;
  inp.addEventListener('focus', () => {
    // Sobe o campo para o teclado não cobrir as sugestões.
    setTimeout(() => inp.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
    if (box.childElementCount && inp.value.trim().length >= 3) box.hidden = false;
  });
  inp.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 300));
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    const t = inp.value.trim();
    if (t.length < 3 || /^-?\d+[.,]\d+/.test(t) || /^https?:/i.test(t)) { box.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      box.hidden = false;
      box.innerHTML = '<li class="sub">🔎 procurando perto de você…</li>';
      let shown = [];
      const render = (list0, done) => {
        if (my !== seq || inp.value.trim() !== t) return;
        // Enquanto ainda procura na sua região, não mostra os muito longe (>80 km),
        // a não ser os famosos (a cidade, o santuário).
        const list = done ? list0 : list0.filter((r) => r.fame || r.km == null || r.km <= 80);
        if (!list.length) {
          box.innerHTML = done ? '<li class="sub">Nenhuma sugestão — continue digitando, ou toque no botão para uma busca completa.</li>' : '<li class="sub">🔎 procurando perto de você…</li>';
          return;
        }
        shown = list;
        // Sobe o campo para o topo: as sugestões ficam acima do teclado.
        inp.scrollIntoView({ block: 'start', behavior: 'smooth' });
        box.innerHTML = list.map((r, i) => {
          const [name, ...rest] = r.label.split(',');
          const pin = r.cls === 'city' ? '🏙️' : r.cls === 'landmark' ? '⭐' : r.cls === 'street' ? '🛣️' : '📍';
          return `<li data-i="${i}"><span class="pin">${pin}</span><div class="grow"><div class="title">${esc(name)}</div><div class="sub">${esc(rest.join(',').trim())}</div></div><span class="km">${fmtKm(r.km)}</span></li>`;
        }).join('') + (done ? '' : '<li class="sub">🔎 procurando mais…</li>');
        for (const li of box.querySelectorAll('li[data-i]')) {
          li.onclick = () => {
            box.hidden = true;
            seq++;
            onPick(shown[+li.dataset.i]);
          };
        }
      };
      let list = [];
      try { list = await suggestPlaces(t, S.here, (l) => render(l, false)); } catch { /* sem internet */ }
      render(list, true);
    }, 450);
  });
}

// Enquanto digita no painel da rota, ele sobe para a tela toda.
$('#v-plan').addEventListener('focusin', (e) => { if (e.target.matches('input')) $('#v-plan').classList.add('expanded'); });
$('#v-plan').addEventListener('focusout', () => setTimeout(() => {
  if (!$('#v-plan').contains(document.activeElement) || !document.activeElement.matches('input')) $('#v-plan').classList.remove('expanded');
}, 350));

// Começou a digitar outro destino: a barra da rota anterior sai da frente.
$('#to').addEventListener('input', () => { if (!S.nav) { showRouteBar(null); clearAlts(); } });

// Destino: tocou na sugestão, já traça a rota (como no Waze).
attachSuggest('#to', (r) => {
  const text = r.label.split(',')[0].trim();
  S.presets.set(text, { lat: r.lat, lon: r.lon, label: r.label });
  $('#to').value = text;
  $('#to').blur();
  $('#btnRoute').click();
});
attachSuggest('#from', (r) => {
  const text = r.label.split(',')[0].trim();
  S.presets.set(text, { lat: r.lat, lon: r.lon, label: r.label });
  setFrom(text);
});
attachSuggest('#tpTo', (r) => {
  const text = r.label.split(',')[0].trim();
  S.presets.set(text, { lat: r.lat, lon: r.lon, label: r.label });
  $('#tpTo').value = text;
});
attachSuggest('#pmAddr', (r) => {
  Object.assign(pm, { lat: r.lat, lon: r.lon, label: r.label });
  $('#pmAddr').value = r.label.split(',')[0];
  $('#pmResults').innerHTML = '';
  $('#pmNotExact').hidden = true;
  pmChosen();
  toast('Dica: toque em “🎯 Ajustar o ponto exato” para marcar a porta certinha.', 4000);
});

// ================= Mapa noturno =================
function applyNight() {
  const h = new Date().getHours();
  const mode = S.settings.nightMap;
  document.body.classList.toggle('night', mode === 'on' || (mode === 'auto' && (h >= 18 || h < 6)));
}
setInterval(() => { if (S.settings) applyNight(); }, 5 * 60000);

$('#btnShowIntro').onclick = () => show('v-intro');

// ================= Retomar viagem interrompida =================
async function checkResume() {
  const a = await Places.active.get();
  if (!a || Date.now() - a.updated > 12 * 3600000) {
    if (a) Places.active.clear();
    return;
  }
  $('#resumeText').innerHTML = `<b>Viagem em andamento:</b> ${esc(a.name)}<br><small>O app foi fechado durante a navegação.</small>`;
  $('#resumeBox').hidden = false;
  $('#btnResume').onclick = async () => {
    $('#resumeBox').hidden = true;
    const trip = a.tripId ? await loadTrip(a.tripId) : null;
    if (a.tripId && !trip) return toast('A viagem salva não existe mais.');
    S.trip = trip;
    startDrive(trip, false, a);
  };
  $('#btnResumeDrop').onclick = async () => {
    $('#resumeBox').hidden = true;
    await Places.active.clear();
  };
}

// ================= Escolha de voz =================
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function renderVoices() {
  const list = Voice.voices();
  const sel = $('#sVoiceName');
  sel.innerHTML = list.length
    ? list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}${Voice.isBR(v) ? ' (Brasil)' : /pt[-_]pt/i.test(v.lang) ? ' (Portugal)' : ` (${esc(v.lang)})`}</option>`).join('')
    : '<option value="">Voz padrão do aparelho</option>';
  if (S.settings.voiceName && list.some((v) => v.name === S.settings.voiceName)) sel.value = S.settings.voiceName;
  else if (list.find(Voice.isBR)) sel.value = list.find(Voice.isBR).name;
  $('#voiceTip').innerHTML = isIOS
    ? 'Quer uma voz mais nítida? No iPhone: <b>Ajustes › Acessibilidade › Conteúdo Falado › Vozes › Português (Brasil)</b> e baixe uma voz <b>“Aprimorada”</b> ou <b>“Premium”</b>. Depois feche e abra o app e escolha aqui.'
    : 'Mais vozes: Configurações do Android › Acessibilidade (ou Idioma) › Conversão de texto em voz › Mecanismo do Google › Instalar dados de voz › Português (Brasil).';
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', () => { if (!$('#v-settings').hidden) renderVoices(); });
$('#sVoiceRate').oninput = () => { $('#sRateVal').textContent = `${Number($('#sVoiceRate').value).toFixed(2).replace('.', ',')}×`; };
$('#btnTestVoice').onclick = () => {
  Voice.unlock();
  // Testa com a voz e a velocidade escolhidas, mesmo antes de salvar.
  Voice.configure({ ...S.settings, voiceName: $('#sVoiceName').value, voiceRate: parseFloat($('#sVoiceRate').value) });
  Voice.beep({ times: 2, force: true });
  Voice.speak('Radar em 500 metros, limite 80. Atenção: o limite cai para 60 em 700 metros.', { urgent: true, force: true });
  setTimeout(() => Voice.configure(S.settings), 500);
};

// ================= Início =================
async function init() {
  S.settings = await getSettings();
  setSearchKey(S.settings.tomtomKey || CONFIG.tomtomKey);
  Voice.configure(S.settings);
  applyName();
  greet();
  await Music.load();
  const spAuth = await Spotify.init(S.settings.spotifyClientId || CONFIG.spotifyClientId);
  applyNight();
  drawRadars();
  drawPlaces();
  renderSavedTrips();
  checkResume();
  Cities.process();
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
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('✨ Nova versão instalada. Feche e abra o app para usar (fora de uma viagem).', 10000);
    });
  }
}

init();

// Para testes no console.
window.__app = { S, map, get mascot() { return mascot; } };
