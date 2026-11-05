const { createServer } = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const roomIdPattern = /^[A-Za-z0-9_-]{22}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const maxPayload = 96 * 1024;

function createSignalingServer() {
  const rooms = new Map();
  const server = createServer((request, response) => {
    const healthy = request.method === 'GET' && request.url === '/health';
    response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(healthy ? 'ok\n' : 'Not found\n');
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });

  function send(socket, packet) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * maxPayload) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(packet));
  }

  function closeRoom(room, reason) {
    rooms.delete(room.id);
    clearTimeout(room.expiry);
    for (const socket of [room.host, room.viewer]) {
      if (socket?.readyState === WebSocket.OPEN) {
        send(socket, { type: 'error', reason });
        socket.close(1000);
      }
    }
  }

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/signal' || sockets.clients.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
  });

  sockets.on('connection', socket => {
    let room;
    let other;
    let remaining = 150;
    let resetAt = Date.now() + 1000;
    const deadline = setTimeout(() => socket.terminate(), 8000);
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => socket.terminate());

    function reject(reason) {
      send(socket, { type: 'error', reason });
      socket.close(1008);
    }

    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now >= resetAt) {
        remaining = 150;
        resetAt = now + 1000;
      }
      if (--remaining < 0 || binary) return reject('Invalid or excessive signaling traffic.');

      let packet;
      try { packet = JSON.parse(data.toString()); } catch { return reject('Invalid signaling message.'); }
      if (!packet || typeof packet !== 'object') return reject('Invalid signaling message.');

      if (room) {
        if (packet.type !== 'signal' || !Number.isSafeInteger(packet.seq) || packet.seq < 1 ||
            typeof packet.mac !== 'string' || !tokenPattern.test(packet.mac) ||
            typeof packet.body !== 'string' || packet.body.length > 80_000) {
          return reject('Invalid signaling message.');
        }
        send(room[other], { type: 'signal', seq: packet.seq, mac: packet.mac, body: packet.body });
        return;
      }

      const { type, id, token } = packet;
      if (typeof id !== 'string' || !roomIdPattern.test(id) ||
          typeof token !== 'string' || !tokenPattern.test(token)) return reject('Invalid invite.');
      if (type === 'host') {
        if (rooms.has(id) || rooms.size >= 64) return reject('The server could not create an invite.');
        room = { id, token, host: socket, viewer: null };
        room.expiry = setTimeout(() => closeRoom(room, 'The invite expired. Create a new one.'), 600_000);
        rooms.set(id, room);
        other = 'viewer';
      } else if (type === 'viewer') {
        const match = rooms.get(id);
        if (!match || match.viewer || match.host.readyState !== WebSocket.OPEN ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(match.token))) {
          return reject('The invite is invalid, expired, or already in use.');
        }
        room = match;
        room.viewer = socket;
        clearTimeout(room.expiry);
        other = 'host';
      } else {
        return reject('Invalid signaling role.');
      }
      clearTimeout(deadline);
      send(socket, { type: 'joined' });
    });

    socket.on('close', () => {
      clearTimeout(deadline);
      if (room && rooms.get(room.id) === room) closeRoom(room, 'The other PC disconnected.');
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!socket.alive) socket.terminate();
      else {
        socket.alive = false;
        socket.ping();
      }
    }
  }, 15_000);
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) clearTimeout(room.expiry);
  });
  return server;
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  createSignalingServer().listen(port, host, () => console.log(`AnySys signaling listening on ${host}:${port}`));
}

module.exports = { createSignalingServer };
