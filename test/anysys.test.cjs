const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { encodeInput } = require('../app/input.cjs');
const { createSignalingServer } = require('../signaling/server.cjs');

test('input is bounded to the selected monitor and only accepts known keys and buttons', () => {
  const bounds = { x: -1920, y: 50, width: 1920, height: 1080 };
  assert.equal(encodeInput({ type: 'move', x: 0, y: 0 }, bounds), 'M -1920 50');
  assert.equal(encodeInput({ type: 'move', x: 1, y: 1 }, bounds), 'M -1 1129');
  assert.equal(encodeInput({ type: 'move', x: 1.01, y: 0 }, bounds), null);
  assert.equal(encodeInput({ type: 'key', code: 'ArrowLeft', down: true }, bounds), 'K 331 1');
  assert.equal(encodeInput({ type: 'key', code: '__proto__', down: true }, bounds), null);
  assert.equal(encodeInput({ type: 'button', x: 0, y: 0, button: 7, down: true }, bounds), null);
  assert.equal(encodeInput({ type: 'wheel', x: 0, y: 0, dx: 0, dy: 1201 }, bounds), null);
});

test('invite round-trips and unauthenticated or replayed signaling cannot reach the app', { timeout: 8000 }, async t => {
  const { createInvite, encodeInvite, readInvite, signalingUrl, Signaling } = await import('../app/signaling.js');
  const server = createSignalingServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  assert.throws(() => signalingUrl('ws://example.com/signal'), /wss/);
  assert.throws(() => signalingUrl('ws://10.0.0.1.example.com/signal'), /wss/);
  const url = signalingUrl(`ws://127.0.0.1:${server.address().port}`);
  const invite = createInvite(url, [], false);
  assert.deepEqual(readInvite(encodeInvite(invite)), invite);

  const received = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const host = new Signaling(invite, 'host', received.resolve, stopped.resolve);
  t.after(() => host.close());
  await host.open();

  const incorrectInvite = { ...createInvite(url, [], false), id: invite.id };
  const wrongViewer = new Signaling(incorrectInvite, 'viewer', () => {}, () => {});
  await assert.rejects(wrongViewer.open(), /invalid, expired, or already in use/);

  const viewer = new Signaling(invite, 'viewer', () => {}, () => {});
  t.after(() => viewer.close());
  await viewer.open();
  const duplicate = new Signaling(invite, 'viewer', () => {}, () => {});
  await assert.rejects(duplicate.open(), /invalid, expired, or already in use/);

  const send = viewer.socket.send.bind(viewer.socket);
  let signed;
  viewer.socket.send = packet => {
    signed = packet;
    send(packet);
  };
  await viewer.send({ type: 'request' });
  assert.deepEqual(await received.promise, { type: 'request' });
  // The signaling relay accepts this shape, but the receiver rejects its reused sequence.
  send(signed);
  assert.match(await stopped.promise, /authenticate/);
});
