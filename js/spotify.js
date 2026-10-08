// Integração com o Spotify: login com autorização (OAuth PKCE, sem senha no app)
// e controle do app do Spotify do celular (tocar playlist/artista, pausar, pular).
// Controlar a reprodução exige conta Spotify Premium.
import { kv } from './store.js';

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative';

let clientId = '';
let tok = null; // { access, refresh, expires }

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function setClientId(id) { clientId = (id || '').trim(); }
export function hasClientId() { return !!clientId; }
export function connected() { return !!tok?.refresh; }

export async function init(id) {
  setClientId(id);
  tok = (await kv.get('spotifyToken')) || null;
  // Voltando da tela de autorização do Spotify?
  const q = new URLSearchParams(location.search);
  if (q.get('state') !== 'spotify') return null;
  history.replaceState(null, '', redirectUri());
  if (q.get('error')) return { error: q.get('error') === 'access_denied' ? 'Autorização negada.' : q.get('error') };
  const verifier = localStorage.getItem('spotifyVerifier');
  if (!q.get('code') || !verifier) return null;
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: verifier });
    localStorage.removeItem('spotifyVerifier');
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  if (!clientId) throw new Error('Informe o Client ID do Spotify primeiro.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem('spotifyVerifier', verifier);
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state: 'spotify',
  });
  location.href = `${AUTH}?${p}`;
}

export async function logout() {
  tok = null;
  await kv.del('spotifyToken');
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || 'Falha na autorização do Spotify');
  tok = {
    access: data.access_token,
    refresh: data.refresh_token || tok?.refresh,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  await kv.set('spotifyToken', tok);
}

async function accessToken() {
  if (!tok?.refresh) throw new Error('Spotify não conectado.');
  if (Date.now() > tok.expires) {
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh });
    } catch (e) {
      if (/invalid_grant|revoked/i.test(e.message)) await logout();
      throw e;
    }
  }
  return tok.access;
}

export class SpotifyError extends Error {
  constructor(msg, reason, status) { super(msg); this.reason = reason; this.status = status; }
}

async function api(path, { method = 'GET', body, query } = {}) {
  const url = `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + (await accessToken()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.status === 202) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = data?.error?.reason || '';
    let msg = data?.error?.message || `Erro ${res.status}`;
    if (reason === 'PREMIUM_REQUIRED' || res.status === 403) msg = 'O Spotify só deixa outros apps controlarem a música em contas Premium.';
    if (reason === 'NO_ACTIVE_DEVICE' || res.status === 404) msg = 'Nenhum Spotify aberto. Abra o app do Spotify e volte.';
    throw new SpotifyError(msg, reason, res.status);
  }
  return data;
}

export const me = () => api('/me');

export async function myPlaylists() {
  const d = await api('/me/playlists', { query: { limit: 50 } });
  return (d?.items || []).filter(Boolean).map(simplify);
}

// A API limita a busca a 10 resultados por página.
export async function search(text) {
  const d = await api('/search', { query: { q: text, type: 'artist,playlist', limit: 10, market: 'from_token' } });
  const artists = (d?.artists?.items || []).filter(Boolean).map((a) => ({
    uri: a.uri, name: a.name, kind: 'artista', image: a.images?.at(-1)?.url || '', url: a.external_urls?.spotify,
  }));
  const playlists = (d?.playlists?.items || []).filter(Boolean).map(simplify);
  return { artists, playlists };
}

function simplify(p) {
  return { uri: p.uri, name: p.name, kind: 'playlist', owner: p.owner?.display_name || '', image: p.images?.at(-1)?.url || '', url: p.external_urls?.spotify };
}

export const devices = async () => (await api('/me/player/devices'))?.devices || [];
export const playback = () => api('/me/player');

// Toca a trilha escolhida. Se o Spotify estiver aberto mas parado, usa esse aparelho.
export async function play(item) {
  let deviceId;
  const devs = await devices();
  if (devs.length && !devs.some((d) => d.is_active)) {
    deviceId = (devs.find((d) => d.type === 'Smartphone') || devs[0]).id;
  }
  const query = deviceId ? { device_id: deviceId } : undefined;
  await api('/me/player/play', { method: 'PUT', query, body: item ? { context_uri: item.uri } : undefined });
  if (item) api('/me/player/shuffle', { method: 'PUT', query: { state: 'true', ...(query || {}) } }).catch(() => {});
}

export const resume = () => play(null);
export const pause = () => api('/me/player/pause', { method: 'PUT' });
export const next = () => api('/me/player/next', { method: 'POST' });
export const prev = () => api('/me/player/previous', { method: 'POST' });

// Link que abre o app do Spotify direto na trilha (funciona até sem Premium).
export function openLink(item) {
  return item?.url || (item?.uri ? `https://open.spotify.com/${item.uri.split(':').slice(1).join('/')}` : 'https://open.spotify.com/search/Nat%20King%20Cole');
}
