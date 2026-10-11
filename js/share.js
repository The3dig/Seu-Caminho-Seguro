// Ver amigo no mapa (posição em tempo real entre os dois celulares).
// Sem servidor próprio: usa o ntfy.sh (serviço gratuito de mensagens) como
// "correio". Cada grupo tem um código (ex.: KRAV-7G2Q-9XPL); o canal e a
// chave de criptografia saem do código, então o ntfy só vê texto embaralhado.
// Só funciona com o app aberto e com internet.
const HOST = 'https://ntfy.sh/';
const enc = new TextEncoder();

export function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para não confundir
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = [...r].map((n) => abc[n % abc.length]).join('');
  return `KRAV-${s.slice(0, 4)}-${s.slice(4)}`;
}
export const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^KRAV/, '');

async function derive(code) {
  const raw = enc.encode('seu-caminho-seguro:' + cleanCode(code));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const topic = 'scs' + [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('chave:' + cleanCode(code))), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, key };
}

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return b64(iv) + '.' + b64(ct);
}
async function open(key, text) {
  const [iv, ct] = String(text).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

export class Share {
  // me = { id, name }; onFriend(friend) a cada posição recebida.
  constructor(code, me, onFriend, onStatus = () => {}) {
    this.code = code; this.me = me; this.onFriend = onFriend; this.onStatus = onStatus;
    this.friends = new Map();
    this.lastSent = 0; this.lastPos = null;
  }

  async start() {
    const { topic, key } = await derive(this.code);
    this.topic = topic; this.key = key;
    this.listen();
  }

  listen() {
    this.es?.close();
    // since=10m: ao entrar, já recebe a última posição do amigo.
    this.es = new EventSource(`${HOST}${this.topic}/sse?since=10m`);
    this.es.onopen = () => this.onStatus('ok');
    this.es.onerror = () => this.onStatus('erro');
    this.es.onmessage = async (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.event && m.event !== 'message') return;
        const p = await open(this.key, m.message);
        if (!p || p.id === this.me.id) return;
        const prev = this.friends.get(p.id);
        if (prev && prev.t > p.t) return; // mensagem velha
        this.friends.set(p.id, p);
        this.onFriend(p);
      } catch { /* mensagem de outro grupo ou corrompida */ }
    };
  }

  // Manda a sua posição (no máximo a cada 15 s, ou 8 s se andou bastante).
  async send(fix, { walk = false, force = false } = {}) {
    if (!this.key || !fix) return;
    const now = Date.now();
    const moved = this.lastPos ? Math.hypot((fix.lat - this.lastPos.lat) * 111000, (fix.lon - this.lastPos.lon) * 111000) : Infinity;
    if (!force && now - this.lastSent < (moved > 80 ? 8000 : 15000)) return;
    this.lastSent = now;
    this.lastPos = { lat: fix.lat, lon: fix.lon };
    const body = await seal(this.key, {
      id: this.me.id, name: this.me.name, lat: +fix.lat.toFixed(5), lon: +fix.lon.toFixed(5),
      kmh: Math.round((fix.speed || 0) * 3.6), heading: fix.heading ?? null, walk, t: now,
    });
    try {
      await fetch(HOST + this.topic, { method: 'POST', body }); // sem cabeçalhos extras (evita pré-checagem CORS)
    } catch { /* sem internet: manda na próxima */ }
  }

  stop() { this.es?.close(); this.es = null; }
}
