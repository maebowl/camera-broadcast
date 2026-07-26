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

// Video quality. Tuned for reading card art/text over smooth motion: high
// resolution + high bitrate + low frame rate, and tell the encoder to favour
// detail. Override per phone with URL params, e.g. ?res=1440&fps=10&kbps=8000
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
const QUALITY = {
  height: clampInt(params.get('res'), 1080, 480, 2160), // vertical resolution
  fps: clampInt(params.get('fps'), 12, 5, 30),
  kbps: clampInt(params.get('kbps'), 5000, 500, 20000), // max bitrate
};

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
      width: { ideal: Math.round((QUALITY.height * 16) / 9) },
      height: { ideal: QUALITY.height },
      frameRate: { ideal: QUALITY.fps, max: 30 },
    },
    audio: false,
  });
  preview.srcObject = localStream;

  // Ask the encoder to favour sharpness/detail over motion smoothness.
  const track = localStream.getVideoTracks()[0];
  if (track && 'contentHint' in track) track.contentHint = 'detail';

  // If already live, swap the new camera into every connection and re-apply
  // the high-quality encoding settings.
  if (live) {
    for (const { pc } of viewers.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(track).catch(() => {});
        applyEncoding(pc);
      }
    }
  }
}

// ---- signaling --------------------------------------------------------------
function connect() {
  ws = new WebSocket(signalingWsUrl());

  ws.onopen = () => {
    setStatus('Live', 'ok');
    ws.send(JSON.stringify({ type: 'join', role: 'broadcaster', room: ROOM, label: currentLabel() }));
    sendState(); // push current life points so the wall has them immediately
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
    await applyEncoding(pc);
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

// Apply high-quality encoding: allow a high bitrate, cap the frame rate so bits
// go to detail, never downscale the resolution, and keep resolution over
// framerate when constrained.
async function applyEncoding(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = QUALITY.kbps * 1000;
    p.encodings[0].maxFramerate = QUALITY.fps;
    p.encodings[0].scaleResolutionDownBy = 1;
    p.degradationPreference = 'maintain-resolution';
    try {
      await sender.setParameters(p);
    } catch {
      // Some browsers reject degradationPreference in setParameters — retry
      // without it so the bitrate/resolution settings still apply.
      delete p.degradationPreference;
      try {
        await sender.setParameters(p);
      } catch {
        /* ignore */
      }
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

// ---- life points ------------------------------------------------------------
const lpState = { start: 8000, step: 500, lp: [8000, 8000] };

const lpPanel = document.getElementById('lp-panel');
const lpStartInput = document.getElementById('lp-start');
const lpNameInputs = [...document.querySelectorAll('.lp-name')];
const lpValEls = [...document.querySelectorAll('.lp-val')];

function renderLpLocal() {
  lpValEls.forEach((el, i) => (el.textContent = lpState.lp[i]));
}

function lpCurrentState() {
  return {
    start: lpState.start,
    players: [0, 1].map((i) => ({ name: lpNameInputs[i].value.trim(), lp: lpState.lp[i] })),
  };
}

// Send the life-point state to the wall (via the signaling channel).
function sendState() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'state', state: lpCurrentState() }));
  }
}

function changeLp(i, delta) {
  lpState.lp[i] = Math.max(0, lpState.lp[i] + delta);
  renderLpLocal();
  sendState();
}

function setLpExact(i, value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return;
  lpState.lp[i] = Math.max(0, n);
  renderLpLocal();
  sendState();
}

function resetLp() {
  lpState.lp = [lpState.start, lpState.start];
  renderLpLocal();
  sendState();
}

document.querySelectorAll('.step').forEach((btn) => {
  btn.addEventListener('click', () => {
    lpState.step = parseInt(btn.dataset.step, 10) || 500;
    document.querySelectorAll('.step').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

document.querySelectorAll('.lp-minus').forEach((btn) =>
  btn.addEventListener('click', () => changeLp(Number(btn.dataset.p), -lpState.step))
);
document.querySelectorAll('.lp-plus').forEach((btn) =>
  btn.addEventListener('click', () => changeLp(Number(btn.dataset.p), lpState.step))
);

lpValEls.forEach((el, i) =>
  el.addEventListener('click', () => {
    const who = lpNameInputs[i].value.trim() || `Player ${i + 1}`;
    const v = prompt(`Set life points for ${who}`, lpState.lp[i]);
    if (v !== null) setLpExact(i, v);
  })
);

lpNameInputs.forEach((inp) => inp.addEventListener('input', sendState));

lpStartInput.addEventListener('change', () => {
  lpState.start = Math.max(0, parseInt(lpStartInput.value, 10) || 0);
  sendState();
});

document.getElementById('lp-reset').addEventListener('click', resetLp);
document.getElementById('lp-toggle').addEventListener('click', () => lpPanel.classList.toggle('hidden'));

renderLpLocal();
