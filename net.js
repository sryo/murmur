// Trystero room lifecycle, data actions, knock/lobby protocol, whisper track-swap
import state, { batch, makePeer, upsertPeer, updatePeer, removePeer } from './state.js';
import {
  getStream, initAudio, initAudioContext, destroyAudio,
  getRealTrack, getSilentTrack, createRemoteAnalyser, removeRemoteAnalyser,
} from './audio.js';
import { joinRoom as trysteroJoin, selfId } from './vendor/trystero-nostr.js';

const APP_ID = 'murmur-ptt';
const AUTO_ADMIT_MS = 3000;

// Signaling relays. Overrides the vendored bundle's stale defaults — the 5 it
// picks for this appId are dead or now require auth. Update here if rooms stop
// connecting again (test: wss handshake + REQ without AUTH demand).
const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.mostr.pub',
  'wss://nostr.vulpem.com',
  'wss://nostr-01.yakihonne.com',
  'wss://purplerelay.com',
  'wss://nostr.sathoarder.com',
];

let room = null;
const send = {}; // talking, whisper, username, rename, idle, knock — filled in setupRoom

const peerTrackState = new Map(); // peerId -> 'real' | 'silent'
const audioEls = new Map();       // peerId -> <audio>
const pendingPeerInfo = new Map(); // peerId -> { username } — peers seen while still knocking
let admitTimeout = null;

// --- wake lock ---

let wakeLock = null;

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && room) requestWakeLock();
  if (!send.idle) return;
  const idle = document.hidden;
  send.idle(idle);
  updatePeer(selfId, { isIdle: idle });
});

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// --- remote audio ---

function playRemoteStream(peerId, stream) {
  let el = audioEls.get(peerId);
  if (!el) {
    el = document.createElement('audio');
    el.autoplay = true;
    document.body.appendChild(el);
    audioEls.set(peerId, el);
  }
  el.srcObject = stream;
  createRemoteAnalyser(peerId, stream);
}

function removeRemoteAudio(peerId) {
  const el = audioEls.get(peerId);
  if (el) {
    el.srcObject = null;
    el.remove();
    audioEls.delete(peerId);
  }
  removeRemoteAnalyser(peerId);
}

function removeKnock(peerId) {
  state.pendingKnocks = state.pendingKnocks.filter(k => k.peerId !== peerId);
}

function admitPeer(peerId, username) {
  upsertPeer(peerId, username);
  peerTrackState.set(peerId, 'real');
}

// --- room setup ---

function setupRoom(code) {
  room = trysteroJoin({ appId: APP_ID, relayConfig: { urls: RELAY_URLS } }, code);

  // Trystero 0.25: makeAction() -> { send, onMessage, onReceiveProgress }.
  // onMessage is an assignable handler property (like el.onclick), not a function to call.
  // It fires as (payload, { peerId, metadata }) — the second arg is an object, not the id.
  function action(name, onMessage) {
    const a = room.makeAction(name);
    a.onMessage = onMessage;
    return a.send;
  }

  send.talking = action('talking', (isTalking, { peerId }) => updatePeer(peerId, { isTalking }));
  send.whisper = action('whisper', ({ isTalking }, { peerId }) => updatePeer(peerId, { isWhispering: isTalking }));
  send.rename = action('rename', (username, { peerId }) => updatePeer(peerId, { username }));
  send.idle = action('idle', (idle, { peerId }) => updatePeer(peerId, { isIdle: idle }));

  send.username = action('username', (username, { peerId }) => {
    updatePeer(peerId, { username });
    if (state.pendingKnocks.some(k => k.peerId === peerId)) {
      state.pendingKnocks = state.pendingKnocks.map(k =>
        k.peerId === peerId ? { ...k, username } : k);
    }
    if (pendingPeerInfo.has(peerId)) {
      pendingPeerInfo.set(peerId, { ...pendingPeerInfo.get(peerId), username });
    }
  });

  send.knock = action('knock', (msg) => {
    if (msg.type === 'admitted') {
      admitSelf();
    } else if (msg.type === 'mode') {
      batch(() => {
        state.knockEnabled = msg.enabled;
        state.creatorId = msg.creatorId;
        if (!msg.enabled && state.pendingKnocks.length) {
          for (const k of state.pendingKnocks) moveKnockToPeers(k.peerId);
          state.pendingKnocks = [];
        }
      });
    } else if (msg.type === 'reply') {
      if (msg.targetPeerId === selfId) {
        if (msg.approved) {
          admitSelf();
        } else {
          state.view = 'rejected';
          setTimeout(() => { leaveRoom(); createRoom(); }, 2000);
        }
      } else if (state.admitted) {
        if (msg.approved) moveKnockToPeers(msg.targetPeerId);
        removeKnock(msg.targetPeerId);
      }
    }
  });

  batch(() => {
    state.myPeerId = selfId;
    state.roomCode = code;
    if (state.admitted) {
      state.view = 'room';
      state.peers = [makePeer(selfId, state.username)];
    } else {
      state.view = 'knocking';
      state.peers = [];
    }
  });
  location.hash = `room=${code}`;

  room.onPeerJoin = peerId => {
    if (!state.admitted) {
      // I'm still knocking — remember who's here, reveal myself, but send no stream yet
      pendingPeerInfo.set(peerId, { username: peerId });
      send.username(state.username, peerId);
      return;
    }

    if (state.knockEnabled) {
      // Queue as pending, send lobby-preview stream + knock prompt
      if (!state.pendingKnocks.some(k => k.peerId === peerId)) {
        state.pendingKnocks = [...state.pendingKnocks, { peerId, username: peerId }];
      }
      send.knock({ type: 'required' }, peerId);
      send.knock({ type: 'mode', enabled: true, creatorId: state.creatorId || selfId }, peerId);
      const stream = getStream();
      if (stream) room.addStream(stream, peerId);
      send.username(state.username, peerId);
      return;
    }

    // Open room: admit immediately
    admitPeer(peerId);
    send.knock({ type: 'admitted' }, peerId);
    send.username(state.username, peerId);
    const stream = getStream();
    if (!stream) return;
    room.addStream(stream, peerId);
    // If I'm mid-whisper to someone else, this new peer must get silence
    if (state.whisperTarget && peerId !== state.whisperTarget) {
      const real = getRealTrack(), silent = getSilentTrack();
      if (real && silent) {
        room.replaceTrack(real, silent, stream, peerId);
        peerTrackState.set(peerId, 'silent');
      }
    }
  };

  room.onPeerLeave = peerId => {
    removePeer(peerId);
    removeKnock(peerId);
    pendingPeerInfo.delete(peerId);
    removeRemoteAudio(peerId);
    peerTrackState.delete(peerId);
    if (peerId === state.creatorId) {
      batch(() => { state.knockEnabled = false; state.creatorId = null; });
    }
  };

  room.onPeerStream = (stream, peerId) => playRemoteStream(peerId, stream);

  requestWakeLock();
}

// --- knock helpers ---

function admitSelf() {
  if (state.admitted) return;
  if (admitTimeout) { clearTimeout(admitTimeout); admitTimeout = null; }
  batch(() => {
    state.admitted = true;
    state.view = 'room';
    const peers = [makePeer(selfId, state.username)];
    for (const [peerId, info] of pendingPeerInfo) peers.push(makePeer(peerId, info.username));
    state.peers = peers;
  });
  for (const [peerId] of pendingPeerInfo) peerTrackState.set(peerId, 'real');
  pendingPeerInfo.clear();
  // Now admitted — send my stream to everyone
  const stream = getStream();
  if (stream && room) {
    for (const p of state.peers) {
      if (p.peerId !== selfId) room.addStream(stream, p.peerId);
    }
  }
}

function moveKnockToPeers(peerId) {
  if (state.peers.some(p => p.peerId === peerId)) return;
  const knock = state.pendingKnocks.find(k => k.peerId === peerId);
  admitPeer(peerId, knock?.username);
}

// --- whisper ---

export function startWhisper(targetPeerId) {
  const real = getRealTrack(), silent = getSilentTrack(), stream = getStream();
  if (!real || !silent || !room || !stream) return;

  state.whisperTarget = targetPeerId;
  real.enabled = true;

  for (const p of state.peers) {
    if (p.peerId === selfId) continue;
    const current = peerTrackState.get(p.peerId) || 'real';
    if (p.peerId === targetPeerId) {
      if (current === 'silent') {
        room.replaceTrack(silent, real, stream, p.peerId);
        peerTrackState.set(p.peerId, 'real');
      }
    } else if (current === 'real') {
      room.replaceTrack(real, silent, stream, p.peerId);
      peerTrackState.set(p.peerId, 'silent');
    }
  }

  send.whisper({ isTalking: true }, targetPeerId);
}

export function stopWhisper(targetPeerId) {
  const real = getRealTrack(), silent = getSilentTrack(), stream = getStream();
  if (!real || !silent || !room || !stream) return;

  state.whisperTarget = null;
  real.enabled = false;

  for (const p of state.peers) {
    if (p.peerId === selfId) continue;
    if ((peerTrackState.get(p.peerId) || 'real') === 'silent') {
      room.replaceTrack(silent, real, stream, p.peerId);
      peerTrackState.set(p.peerId, 'real');
    }
  }

  send.whisper({ isTalking: false }, targetPeerId);
}

// --- public API ---

export function sendTalkingState(isTalking) {
  send.talking?.(isTalking);
}

export function sendRename(username) {
  send.rename?.(username);
}

export function toggleKnockMode() {
  if (state.creatorId !== state.myPeerId) return;
  const enabled = !state.knockEnabled;
  batch(() => {
    state.knockEnabled = enabled;
    if (!enabled && state.pendingKnocks.length) {
      for (const k of state.pendingKnocks) {
        send.knock({ type: 'reply', targetPeerId: k.peerId, approved: true });
        moveKnockToPeers(k.peerId);
      }
      state.pendingKnocks = [];
    }
  });
  send.knock({ type: 'mode', enabled, creatorId: selfId });
}

export function resolveKnock(peerId, approved) {
  send.knock({ type: 'reply', targetPeerId: peerId, approved });
  if (approved) moveKnockToPeers(peerId);
  removeKnock(peerId);
}

// --- lifecycle ---

export async function createRoom() {
  state.admitted = true;
  state.creatorId = null;
  try { await initAudio(); } catch { initAudioContext(); state.noMic = true; }
  setupRoom(genCode());
  state.creatorId = selfId;
}

export async function joinRoom(code) {
  code = code.toUpperCase().trim();
  if (!code) return;
  state.admitted = false;
  try { await initAudio(); } catch { initAudioContext(); state.noMic = true; }
  setupRoom(code);
  // Empty room: nobody answers within the window -> become the creator
  admitTimeout = setTimeout(() => {
    if (!state.admitted) { state.creatorId = selfId; admitSelf(); }
  }, AUTO_ADMIT_MS);
}

export function leaveRoom() {
  for (const el of audioEls.values()) { el.srcObject = null; el.remove(); }
  audioEls.clear();
  peerTrackState.clear();
  pendingPeerInfo.clear();
  destroyAudio();
  releaseWakeLock();
  if (admitTimeout) { clearTimeout(admitTimeout); admitTimeout = null; }
  if (room) { room.leave(); room = null; }
  for (const k of Object.keys(send)) delete send[k];
  batch(() => {
    state.peers = [];
    state.isTalking = false;
    state.whisperTarget = null;
    state.knockEnabled = false;
    state.admitted = true;
    state.pendingKnocks = [];
    state.creatorId = null;
  });
}
