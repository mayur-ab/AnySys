const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const roomPattern = /^[A-Za-z0-9_-]{22}$/;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

export function signalingUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid signaling URL.'); }
  const octets = url.hostname.split('.').map(Number);
  const [a, b] = octets;
  const local = ['localhost', '[::1]'].includes(url.hostname) ||
    (octets.length === 4 && octets.every(Number.isInteger) &&
      (a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)));
  if (url.protocol !== 'wss:' && (url.protocol !== 'ws:' || !local)) {
    throw new Error('Use wss:// for internet signaling, or ws:// on localhost or a trusted private LAN.');
  }
  if (url.username || url.password || url.search || url.hash || !['/', '/signal'].includes(url.pathname)) {
    throw new Error('Use a signaling URL ending in /signal with no credentials, query, or fragment.');
  }
  url.pathname = '/signal';
  return url.href;
}

export function iceServers(value) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('ICE servers must be a JSON array with up to eight entries.');
  return value.map(entry => {
    const urls = typeof entry?.urls === 'string' ? [entry.urls] : entry?.urls;
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8 ||
        urls.some(url => typeof url !== 'string' || !/^(stuns?|turns?):[^\s/@#]+$/i.test(url) || url.length > 256)) {
      throw new Error('Each ICE server needs a valid STUN or TURN URL.');
    }
    if ([entry.username, entry.credential].some(item =>
      item !== undefined && (typeof item !== 'string' || item.length > 256))) {
      throw new Error('TURN usernames and credentials must be strings of up to 256 characters.');
    }
    if (urls.some(url => /^turns?:/i.test(url)) && (!entry.username || !entry.credential)) {
      throw new Error('TURN servers require a username and credential.');
    }
    return { urls, username: entry.username, credential: entry.credential };
  });
}

export function createInvite(url, ice, relay) {
  if (relay && !ice.some(entry => entry.urls.some(url => /^turns?:/i.test(url)))) {
    throw new Error('Relay-only mode requires a TURN server.');
  }
  return {
    url, ice, relay,
    id: base64url(crypto.getRandomValues(new Uint8Array(16))),
    key: base64url(crypto.getRandomValues(new Uint8Array(32)))
  };
}

export function encodeInvite(invite) {
  const value = 'anysys1.' + base64url(encoder.encode(JSON.stringify(invite)));
  if (value.length > 8192) throw new Error('The ICE configuration is too large for an invite.');
  return value;
}

export function readInvite(value) {
  value = value.trim();
  if (value.length > 8192 || !/^anysys1\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Paste the full AnySys invite from your friend.');
  }
  let invite;
  try { invite = JSON.parse(decoder.decode(decode(value.slice(8)))); } catch {
    throw new Error('The invite could not be decoded.');
  }
  if (typeof invite?.url !== 'string' || typeof invite.id !== 'string' || !roomPattern.test(invite.id) ||
      typeof invite.key !== 'string' || !keyPattern.test(invite.key) || typeof invite.relay !== 'boolean') {
    throw new Error('The invite is incomplete.');
  }
  const ice = iceServers(invite.ice);
  if (invite.relay && !ice.some(entry => entry.urls.some(url => /^turns?:/i.test(url)))) {
    throw new Error('The invite requires a TURN server.');
  }
  return { id: invite.id, key: invite.key, url: signalingUrl(invite.url), ice, relay: invite.relay };
}

export class Signaling {
  constructor(invite, role, onMessage, onFailure) {
    this.invite = invite;
    this.role = role;
    this.other = role === 'host' ? 'viewer' : 'host';
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    this.inSeq = 0;
    this.outSeq = 0;
    this.incoming = Promise.resolve();
    this.outgoing = Promise.resolve();
  }

  async open() {
    this.key = await crypto.subtle.importKey('raw', decode(this.invite.key),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const token = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', this.key,
      encoder.encode('anysys1 join ' + this.invite.id))));
    if (this.closed) return;
    const socket = this.socket = new WebSocket(this.invite.url);
    return new Promise((resolve, reject) => {
      const fail = reason => {
        if (this.closed) return;
        this.close();
        if (this.joined) this.onFailure(reason);
        else reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('The signaling server did not respond.'), 10_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: this.role, id: this.invite.id, token }));
      socket.onerror = () => fail('Could not reach the signaling server. Check the address and firewall.');
      socket.onclose = () => {
        clearTimeout(timer);
        if (this.closed && !this.joined) reject(new Error('Signaling closed.'));
        else fail('The signaling connection closed.');
      };
      socket.onmessage = event => {
        this.incoming = this.incoming.then(async () => {
          if (this.closed) return;
          const packet = JSON.parse(event.data);
          if (packet.type === 'error') {
            fail(typeof packet.reason === 'string' ? packet.reason.slice(0, 200) : 'Signaling failed.');
          } else if (packet.type === 'joined' && !this.joined) {
            this.joined = true;
            clearTimeout(timer);
            resolve();
          } else if (packet.type === 'signal' && this.joined) {
            await this.receive(packet);
          } else {
            throw new Error('Invalid signaling message.');
          }
        }).catch(error => fail(error.message));
      };
    });
  }

  signedBytes(role, seq, body) {
    return encoder.encode(JSON.stringify(['anysys1 signal', this.invite.id, role, seq, body]));
  }

  send(value) {
    const task = this.outgoing.then(async () => {
      if (this.closed) return;
      const seq = ++this.outSeq;
      const body = JSON.stringify(value);
      const mac = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', this.key,
        this.signedBytes(this.role, seq, body))));
      if (!this.closed) this.socket.send(JSON.stringify({ type: 'signal', seq, body, mac }));
    });
    this.outgoing = task.catch(() => {});
    return task;
  }

  async receive({ seq, body, mac }) {
    if (seq !== this.inSeq + 1 || typeof body !== 'string' || body.length > 80_000 ||
        typeof mac !== 'string' || !keyPattern.test(mac) ||
        !await crypto.subtle.verify('HMAC', this.key, decode(mac), this.signedBytes(this.other, seq, body))) {
      throw new Error('Could not authenticate your friend. Create a new invite.');
    }
    if (this.closed) return;
    this.inSeq = seq;
    await this.onMessage(JSON.parse(body));
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
