import { createInvite, encodeInvite, iceServers, readInvite, signalingUrl, Signaling } from './signaling.js';
import { bindViewerInput } from './viewer-input.js';

const $ = id => document.getElementById(id);
const desktop = window.desktop;
const video = $('remote');
const viewport = $('viewport');
let active;

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function show(id) {
  for (const page of ['home', 'waiting', 'host-active', 'view']) $(page).hidden = page !== id;
}

function waiting(current, title, text, { invite = false, approval = false } = {}) {
  show('waiting');
  $('waiting-tag').textContent = current.role.toUpperCase();
  $('waiting-title').textContent = title;
  $('waiting-text').textContent = text;
  $('outgoing').hidden = !invite;
  $('approval').hidden = !approval;
  $('cancel').textContent = approval ? 'Decline' : 'Cancel';
}

async function refreshDisplays() {
  const select = $('display');
  const previous = select.value;
  const displays = await desktop.listDisplays();
  select.replaceChildren(...displays.map(display => new Option(display.label, String(display.id))));
  if (displays.some(display => String(display.id) === previous)) select.value = previous;
  else if (displays.some(display => display.primary)) select.value = String(displays.find(display => display.primary).id);
}

function finish(current, message) {
  if (!current || active !== current) return;
  active = undefined;
  resetInput();
  clearTimeout(current.deadline);
  clearInterval(current.heartbeat);
  current.signal.close();
  current.channel?.close();
  current.pc?.close();
  current.stream?.getTracks().forEach(track => track.stop());
  if (current.role === 'host') desktop.stop().catch(console.error);
  video.srcObject = null;
  $('play-audio').hidden = true;
  $('invite-out').value = '';
  $('allow-control').checked = false;
  $('copy').textContent = 'Copy invite';
  viewport.classList.remove('controlling');
  show('home');
  notice(message);
  refreshDisplays().catch(console.error);
}

function setDeadline(current, milliseconds, reason) {
  clearTimeout(current.deadline);
  current.deadline = setTimeout(() => finish(current, reason), milliseconds);
}

function fail(current, error) {
  finish(current, error?.message || 'The session could not be started.');
}

function send(current, message) {
  return current.signal.send(message);
}

function begin(invite, role, state = {}) {
  const current = { role, invite, candidates: [], ...state };
  current.signal = new Signaling(invite, role, message => onSignal(current, message),
    reason => finish(current, reason));
  active = current;
  notice('');
  waiting(current, 'Connecting to signaling…', 'Checking the session address.');
  return current;
}

function configurePeer(current) {
  const pc = new RTCPeerConnection({
    iceServers: current.invite.ice,
    iceTransportPolicy: current.invite.relay ? 'relay' : 'all'
  });
  current.pc = pc;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && active === current) {
      send(current, { type: 'ice', candidate: candidate.toJSON() }).catch(error => fail(current, error));
    }
  };
  pc.onicecandidateerror = ({ errorText }) => console.warn('ICE candidate:', errorText);
  pc.onconnectionstatechange = () => {
    if (active !== current) return;
    if (pc.connectionState === 'connected') {
      if (!current.control || current.channel?.readyState === 'open') clearTimeout(current.deadline);
      if (current.role === 'host') {
        show('host-active');
        $('sharing-status').textContent = current.control
          ? 'Your friend can see your screen and use your mouse and keyboard.'
          : 'Your friend can see your screen in view-only mode.';
      }
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      finish(current, 'The desktop connection ended. For separate networks, check the TURN configuration.');
    }
  };
  return pc;
}

function attachChannel(current, channel) {
  if (current.channel || !current.control || channel.label !== 'input') {
    channel.close();
    return;
  }
  current.channel = channel;
  channel.onclose = () => finish(current, 'The remote control channel closed.');
  channel.onerror = () => finish(current, 'The remote control channel failed.');
  channel.onopen = () => {
    if (active !== current) return;
    if (current.pc.connectionState === 'connected') clearTimeout(current.deadline);
    if (current.role === 'viewer') {
      viewport.classList.add('controlling');
      $('control-status').textContent = 'Click the display to type. Ctrl + Shift + F8 releases keyboard focus.';
      channel.send('ping');
      current.heartbeat = setInterval(() => {
        if (channel.readyState === 'open') {
          if (channel.bufferedAmount > 4096) finish(current, 'The control connection became too slow.');
          else channel.send('ping');
        }
      }, 1000);
    } else {
      current.lastInput = performance.now();
      current.heartbeat = setInterval(() => {
        if (performance.now() - current.lastInput > 6000) {
          finish(current, 'The remote control connection stopped responding.');
        }
      }, 1000);
    }
  };
  if (current.role === 'host') {
    channel.onmessage = ({ data }) => {
      if (active !== current) return;
      if (typeof data !== 'string' || data.length > 256) {
        finish(current, 'An invalid remote input message ended the session.');
        return;
      }
      current.lastInput = performance.now();
      if (data === 'ping') return;
      try { desktop.input(JSON.parse(data)); } catch { finish(current, 'Invalid remote input.'); }
    };
  }
}

const connectionTimeout = 'Could not establish a desktop connection. For separate networks, check that a TURN relay is configured and reachable.';

async function setRemote(current, description) {
  await current.pc.setRemoteDescription(description);
  for (const candidate of current.candidates) await current.pc.addIceCandidate(candidate);
  current.candidates.length = 0;
}

async function onSignal(current, message) {
  if (active !== current) return;
  if (message?.type === 'request' && current.role === 'host' && !current.requested) {
    current.requested = true;
    waiting(current, 'Connection request', 'Approve only if you were expecting your friend. View-only is selected by default.',
      { approval: true });
    setDeadline(current, 90_000, 'The approval request expired.');
  } else if (message?.type === 'offer' && current.role === 'viewer' && !current.pc &&
      typeof message.control === 'boolean' && typeof message.sdp === 'string') {
    current.control = message.control;
    setDeadline(current, 40_000, connectionTimeout);
    const pc = configurePeer(current);
    pc.ondatachannel = ({ channel }) => attachChannel(current, channel);
    pc.ontrack = ({ streams }) => {
      if (active !== current || !streams[0]) return;
      video.srcObject = streams[0];
      video.play().catch(() => { if (active === current) $('play-audio').hidden = false; });
    };
    $('control-status').textContent = current.control ? 'Connecting remote control…' : 'View-only session';
    $('remote-loading').hidden = false;
    show('view');
    await setRemote(current, { type: 'offer', sdp: message.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await send(current, { type: 'answer', sdp: pc.localDescription.sdp });
  } else if (message?.type === 'answer' && current.role === 'host' &&
      current.pc?.signalingState === 'have-local-offer' && typeof message.sdp === 'string') {
    await setRemote(current, { type: 'answer', sdp: message.sdp });
  } else if (message?.type === 'ice' && message.candidate && typeof message.candidate.candidate === 'string') {
    if (current.pc?.remoteDescription) await current.pc.addIceCandidate(message.candidate);
    else if (current.candidates.length < 256) current.candidates.push(message.candidate);
    else throw new Error('Too many connection candidates.');
  } else {
    throw new Error('Unexpected session message.');
  }
}

$('host-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (active) return;
  let current;
  try {
    const url = signalingUrl($('server').value);
    const ice = iceServers(JSON.parse($('ice').value.trim() || '[]'));
    const invite = createInvite(url, ice, $('relay').checked);
    const encoded = encodeInvite(invite);
    localStorage.setItem('signaling-url', url);
    current = begin(invite, 'host', { display: Number($('display').value), audio: $('audio').checked });
    await current.signal.open();
    if (active !== current || current.requested) return;
    $('invite-out').value = encoded;
    waiting(current, 'Invite ready', 'Send this invite privately. It expires in 10 minutes if nobody joins.',
      { invite: true });
  } catch (error) {
    if (current) fail(current, error);
    else notice(error.message);
  }
});

$('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (active) return;
  let current;
  try {
    const invite = readInvite($('invite-in').value);
    current = begin(invite, 'viewer');
    $('invite-in').value = '';
    await current.signal.open();
    if (active !== current) return;
    waiting(current, 'Waiting for approval', 'Your friend needs to approve sharing on their PC.');
    setDeadline(current, 100_000, 'Your friend did not approve the request in time.');
    await send(current, { type: 'request' });
  } catch (error) {
    if (current) fail(current, error);
    else notice(error.message);
  }
});

$('approve').addEventListener('click', async () => {
  const current = active;
  if (current?.role !== 'host' || !current.requested || current.approved) return;
  current.approved = true;
  current.control = $('allow-control').checked;
  waiting(current, 'Starting screen sharing…', 'Establishing a direct or relayed connection.');
  setDeadline(current, 40_000, connectionTimeout);
  try {
    await desktop.prepare(current.display, current.audio, current.control);
    if (active !== current) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: current.audio
    });
    if (active !== current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    current.stream = stream;
    const [screenTrack] = stream.getVideoTracks();
    screenTrack.contentHint = 'detail';
    screenTrack.onended = () => finish(current, 'Windows ended screen capture.');
    await desktop.activate();
    if (active !== current) return;
    const pc = configurePeer(current);
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    if (current.control) attachChannel(current, pc.createDataChannel('input'));
    await pc.setLocalDescription(await pc.createOffer());
    await send(current, { type: 'offer', sdp: pc.localDescription.sdp, control: current.control });
  } catch (error) {
    fail(current, error);
  }
});

const canControl = () => active?.role === 'viewer' && active.channel?.readyState === 'open';
const resetInput = bindViewerInput(viewport, video, $('disconnect'), canControl, input => {
  if (active.channel.bufferedAmount > 4096) finish(active, 'The control connection became too slow.');
  else active.channel.send(JSON.stringify(input));
});

video.addEventListener('playing', () => {
  $('play-audio').hidden = true;
  $('remote-loading').hidden = true;
});
$('play-audio').addEventListener('click', () => video.play().catch(error => notice(error.message)));
$('copy').addEventListener('click', async () => {
  try {
    await desktop.copy($('invite-out').value);
    if (active?.role === 'host') $('copy').textContent = 'Copied';
  } catch (error) {
    notice(error.message);
  }
});
$('cancel').addEventListener('click', () => finish(active, 'Session canceled.'));
$('disconnect').addEventListener('click', () => finish(active, 'Disconnected.'));
$('stop-host').addEventListener('click', () => finish(active, 'Sharing stopped.'));
desktop.onStop(reason => { if (active?.role === 'host') finish(active, reason); });

$('server').value = localStorage.getItem('signaling-url') || $('server').value;
refreshDisplays().catch(error => notice(error.message));
