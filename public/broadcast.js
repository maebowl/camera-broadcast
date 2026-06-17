'use strict';

/**
 * Phone broadcaster (broadcast.mabelwallin.com): captures the camera and sends
 * it to every viewer on the wall over WebRTC. The phone is the "offerer" — it
 * owns the video, so it creates one peer connection per viewer.
 *
 * Signaling lives on the wall site, so this connects its WebSocket there.
 * Override with ?signal=https://host for testing.
 */

const params = new URLSearchParams(location.search);
const ROOM = params.get('room') || 'main';
const presetTable = params.get('table');

// Where the signaling Worker lives (the live/wall site).
const SIGNAL_ORIGIN =
  params.get('signal') ||
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? location.origin
    : 'https://live.mabelwallin.com');

function signalingWsUrl() {
  const base = SIGNAL_ORIGIN.replace(/\/+$/, '').replace(/^http/i, 'ws'); // http->ws, https->wss
  return `${base}/ws?room=${encodeURIComponent(ROOM)}`;
}

let ws;
let myId = null;
let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];

let localStream = null;
let facing = 'environment'; // rear camera by default — pointed at the table
let live = false;
let wakeLock = null;

/** viewerId -> { pc, remoteSet, pending: [] } */
const viewers = new Map();

const preview = document.getElementById('preview');
const labelInput = document.getElementById('label');
const startBtn = document.getElementById('start');
const switchBtn = document.getElementById('switch');
const statusEl = document.getElementById('status');
const viewersEl = document.getElementById('viewers');
const hintEl = document.getElementById('hint');

if (presetTable) labelInput.value = `Table ${presetTable}`;

// ---- camera -----------------------------------------------------------------
async function openCamera() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    },
    audio: false,
  });
  preview.srcObject = localStream;

  // If already live, swap the new camera into every existing connection.
  if (live) {
    const newTrack = localStream.getVideoTracks()[0];
    for (const { pc } of viewers.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newTrack).catch(() => {});
    }
  }
}

// ---- signaling --------------------------------------------------------------
function connect() {
  ws = new WebSocket(signalingWsUrl());

  ws.onopen = () => {
    setStatus('Live', 'ok');
    ws.send(JSON.stringify({ type: 'join', role: 'broadcaster', room: ROOM, label: currentLabel() }));
  };
  ws.onclose = () => {
    if (live) {
      setStatus('Reconnecting…', 'warn');
      setTimeout(connect, 1500);
    }
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };
}

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
      break;
    case 'peers': // existing viewers -> offer to each
      msg.peers.forEach((p) => offerTo(p.id));
      break;
    case 'peer-joined': // a new viewer arrived
      offerTo(msg.id);
      break;
    case 'peer-left':
      dropViewer(msg.id);
      break;
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
  }
}

function sendSignal(to, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', to, data }));
  }
}

// ---- one peer connection per viewer ----------------------------------------
async function offerTo(viewerId) {
  if (viewers.has(viewerId) || !localStream) return;

  const pc = new RTCPeerConnection({ iceServers });
  const entry = { pc, remoteSet: false, pending: [] };
  viewers.set(viewerId, entry);
  updateViewerCount();

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(viewerId, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      dropViewer(viewerId);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await capBitrate(pc, 1200);
    sendSignal(viewerId, { sdp: pc.localDescription, label: currentLabel() });
  } catch {
    dropViewer(viewerId);
  }
}

async function onSignal(from, data) {
  const entry = viewers.get(from);
  if (!entry) return;
  if (data.sdp && data.sdp.type === 'answer') {
    await entry.pc.setRemoteDescription(data.sdp);
    entry.remoteSet = true;
    for (const c of entry.pending) entry.pc.addIceCandidate(c).catch(() => {});
    entry.pending = [];
  } else if (data.candidate) {
    if (entry.remoteSet) entry.pc.addIceCandidate(data.candidate).catch(() => {});
    else entry.pending.push(data.candidate);
  }
}

function dropViewer(viewerId) {
  const entry = viewers.get(viewerId);
  if (!entry) return;
  entry.pc.close();
  viewers.delete(viewerId);
  updateViewerCount();
}

// Cap each stream's bitrate so many feeds don't saturate the wall's bandwidth.
async function capBitrate(pc, kbps) {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = kbps * 1000;
    try {
      await sender.setParameters(p);
    } catch {
      /* not supported on some browsers; ignore */
    }
  }
}

// ---- screen wake lock (keep the phone awake while streaming) ----------------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* ignore */
  }
}
document.addEventListener('visibilitychange', () => {
  if (live && document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
});

// ---- UI ---------------------------------------------------------------------
function currentLabel() {
  return labelInput.value.trim() || `Feed ${myId || ''}`.trim();
}
function updateViewerCount() {
  viewersEl.textContent = viewers.size;
}
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

async function goLive() {
  setStatus('Starting camera…', 'warn');
  try {
    await openCamera();
  } catch (e) {
    setStatus('Camera blocked', 'bad');
    hintEl.textContent =
      'Could not access the camera. Make sure this page is on HTTPS and that you allowed camera permission.';
    return;
  }
  live = true;
  requestWakeLock();
  connect();

  startBtn.textContent = 'Stop';
  startBtn.classList.remove('primary');
  startBtn.classList.add('live');
  labelInput.disabled = true;
  hintEl.textContent = 'You are live. Keep this screen on and pointed at the table.';
}

function stop() {
  live = false;
  for (const id of [...viewers.keys()]) dropViewer(id);
  if (ws) ws.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  preview.srcObject = null;

  startBtn.textContent = 'Go live';
  startBtn.classList.add('primary');
  startBtn.classList.remove('live');
  labelInput.disabled = false;
  setStatus('Stopped', '');
  hintEl.textContent = 'Tap “Go live”, then allow camera access when asked.';
}

startBtn.addEventListener('click', () => (live ? stop() : goLive()));

switchBtn.addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try {
    await openCamera();
  } catch {
    setStatus('Could not switch camera', 'bad');
  }
});
