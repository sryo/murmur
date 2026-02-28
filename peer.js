// Trystero: decentralized room API, mesh networking, data actions
import state, { batch } from './state.js';
import { getStream, initAudio, initAudioContext, destroyAudio, getRealTrack, getSilentTrack, createRemoteAnalyser, removeRemoteAnalyser } from './audio.js';
import { joinRoom as trysteroJoin, selfId } from 'https://esm.run/trystero/nostr';

const APP_ID = 'murmur-ptt';
let room = null;
let sendTalking = null;
let sendWhisperMsg = null;
let sendUsernameMsg = null;
let sendRenameMsg = null;
let sendIdleMsg = null;
let sendKnockMsg = null;
const peerTrackState = new Map(); // peerId -> 'real' | 'silent'
let activeWhisperTarget = null;
const audioEls = new Map();
const pendingPeerInfo = new Map(); // peerId -> { username } — peers seen before admission
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

  if (!sendIdleMsg) return;
  const idle = document.hidden;
  sendIdleMsg(idle);
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

function updatePeer(peerId, updates) {
  state.peers = state.peers.map(p =>
    p.peerId === peerId ? { ...p, ...updates } : p
  );
}

// --- room setup ---

function setupRoom(code) {
  room = trysteroJoin({ appId: APP_ID }, code);

  // Create data actions
  let getTalking, getWhisper, getUsername, getRename;
  [sendTalking, getTalking] = room.makeAction('talking');
  [sendWhisperMsg, getWhisper] = room.makeAction('whisper');
  [sendUsernameMsg, getUsername] = room.makeAction('username');
  [sendRenameMsg, getRename] = room.makeAction('rename');
  let getIdle;
  [sendIdleMsg, getIdle] = room.makeAction('idle');
  let getKnock;
  [sendKnockMsg, getKnock] = room.makeAction('knock');

  // Set self state — knockers start in 'knocking' view
  batch(() => {
    state.myPeerId = selfId;
    state.roomCode = code;
    if (state.admitted) {
      state.view = 'room';
      state.peers = [{ peerId: selfId, username: state.username, isTalking: false, isIdle: false }];
    } else {
      state.view = 'knocking';
      state.peers = [];
    }
  });
  location.hash = `room=${code}`;

  // Receive handlers
  getUsername((username, peerId) => {
    updatePeer(peerId, { username });
    // Also update pendingKnocks and pendingPeerInfo
    const knock = state.pendingKnocks.find(k => k.peerId === peerId);
    if (knock) {
      state.pendingKnocks = state.pendingKnocks.map(k =>
        k.peerId === peerId ? { ...k, username } : k
      );
    }
    if (pendingPeerInfo.has(peerId)) {
      pendingPeerInfo.set(peerId, { ...pendingPeerInfo.get(peerId), username });
    }
  });

  getTalking((isTalking, peerId) => {
    updatePeer(peerId, { isTalking });
  });

  getWhisper(({ isTalking }, peerId) => {
    updatePeer(peerId, { isWhispering: isTalking });
  });

  getRename((username, peerId) => {
    updatePeer(peerId, { username });
  });

  getIdle((idle, peerId) => {
    updatePeer(peerId, { isIdle: idle });
  });

  // Knock receive handler
  getKnock((msg, peerId) => {
    if (msg.type === 'required') {
      state.knockWaiting = true;
    } else if (msg.type === 'admitted') {
      admitSelf();
    } else if (msg.type === 'mode') {
      batch(() => {
        state.knockEnabled = msg.enabled;
        state.creatorId = msg.creatorId;
      });
      // Auto-admit pending knockers if knock turned off
      if (!msg.enabled && state.pendingKnocks.length > 0) {
        for (const k of state.pendingKnocks) {
          moveKnockToPeers(k.peerId);
        }
        state.pendingKnocks = [];
      }
    } else if (msg.type === 'reply') {
      if (msg.targetPeerId === selfId) {
        if (msg.approved) {
          admitSelf();
        } else {
          state.view = 'rejected';
          setTimeout(() => { leaveRoom(); createRoom(); }, 2000);
        }
      } else if (state.admitted) {
        // I'm an existing peer — update my knock/peer lists
        if (msg.approved) {
          moveKnockToPeers(msg.targetPeerId);
          state.pendingKnocks = state.pendingKnocks.filter(k => k.peerId !== msg.targetPeerId);
        } else {
          state.pendingKnocks = state.pendingKnocks.filter(k => k.peerId !== msg.targetPeerId);
        }
      }
    }
  });

  // Peer lifecycle
  room.onPeerJoin(peerId => {
    if (state.admitted) {
      // I'm an existing peer
      if (state.knockEnabled) {
        // Knock mode: queue as pending, send preview stream, request knock
        if (!state.pendingKnocks.find(k => k.peerId === peerId)) {
          state.pendingKnocks = [...state.pendingKnocks, { peerId, username: peerId }];
        }
        sendKnockMsg({ type: 'required' }, peerId);
        sendKnockMsg({ type: 'mode', enabled: true, creatorId: state.creatorId || selfId }, peerId);
        // Send stream so knocker hears the room (lobby preview)
        const stream = getStream();
        if (stream) room.addStream(stream, peerId);
        sendUsernameMsg(state.username, peerId);
      } else {
        // No knock: add peer normally
        if (!state.peers.find(p => p.peerId === peerId)) {
          state.peers = [...state.peers, { peerId, username: peerId, isTalking: false, isIdle: false }];
        }
        sendKnockMsg({ type: 'admitted' }, peerId);
        sendUsernameMsg(state.username, peerId);
        const stream = getStream();
        if (stream) {
          room.addStream(stream, peerId);
          if (activeWhisperTarget && peerId !== activeWhisperTarget) {
            const realTrack = getRealTrack();
            const silent = getSilentTrack();
            if (realTrack && silent) {
              room.replaceTrack(realTrack, silent, stream, peerId);
              peerTrackState.set(peerId, 'silent');
            }
          }
        }
      }
    } else {
      // I'm a new/knocking peer — queue info, don't send stream yet
      pendingPeerInfo.set(peerId, { username: peerId });
      sendUsernameMsg(state.username, peerId);
    }
  });

  room.onPeerLeave(peerId => {
    state.peers = state.peers.filter(p => p.peerId !== peerId);
    state.pendingKnocks = state.pendingKnocks.filter(k => k.peerId !== peerId);
    pendingPeerInfo.delete(peerId);
    removeRemoteAudio(peerId);
    peerTrackState.delete(peerId);
    // If creator leaves, disable knock mode
    if (peerId === state.creatorId) {
      batch(() => {
        state.knockEnabled = false;
        state.creatorId = null;
      });
    }
  });

  room.onPeerStream((stream, peerId) => {
    playRemoteStream(peerId, stream);
  });

  requestWakeLock();
}

// --- knock helpers ---

function admitSelf() {
  if (state.admitted) return;
  if (admitTimeout) { clearTimeout(admitTimeout); admitTimeout = null; }
  batch(() => {
    state.admitted = true;
    state.knockWaiting = false;
    state.view = 'room';
    // Build peers from pendingPeerInfo + self
    const peers = [{ peerId: selfId, username: state.username, isTalking: false, isIdle: false }];
    for (const [peerId, info] of pendingPeerInfo) {
      peers.push({ peerId, username: info.username || peerId, isTalking: false, isIdle: false });
    }
    state.peers = peers;
  });
  pendingPeerInfo.clear();
  // Send own stream to all peers now that we're admitted
  const stream = getStream();
  if (stream && room) {
    for (const p of state.peers) {
      if (p.peerId === selfId) continue;
      room.addStream(stream, p.peerId);
    }
  }
}

function moveKnockToPeers(peerId) {
  if (state.peers.find(p => p.peerId === peerId)) return;
  const knock = state.pendingKnocks.find(k => k.peerId === peerId);
  const username = knock ? knock.username : peerId;
  state.peers = [...state.peers, { peerId, username, isTalking: false, isIdle: false }];
}

// --- whisper ---

export function startWhisper(targetPeerId) {
  const realTrack = getRealTrack();
  const silent = getSilentTrack();
  const stream = getStream();
  if (!realTrack || !silent || !room || !stream) return;

  activeWhisperTarget = targetPeerId;
  realTrack.enabled = true;

  for (const p of state.peers) {
    if (p.peerId === selfId) continue;
    const current = peerTrackState.get(p.peerId) || 'real';
    if (p.peerId === targetPeerId) {
      if (current === 'silent') {
        room.replaceTrack(silent, realTrack, stream, p.peerId);
        peerTrackState.set(p.peerId, 'real');
      }
    } else {
      if (current === 'real') {
        room.replaceTrack(realTrack, silent, stream, p.peerId);
        peerTrackState.set(p.peerId, 'silent');
      }
    }
  }

  sendWhisperMsg({ isTalking: true }, targetPeerId);
}

export function stopWhisper(targetPeerId) {
  const realTrack = getRealTrack();
  const silent = getSilentTrack();
  const stream = getStream();
  if (!realTrack || !silent || !room || !stream) return;

  activeWhisperTarget = null;
  realTrack.enabled = false;

  for (const p of state.peers) {
    if (p.peerId === selfId) continue;
    const current = peerTrackState.get(p.peerId) || 'real';
    if (current === 'silent') {
      room.replaceTrack(silent, realTrack, stream, p.peerId);
      peerTrackState.set(p.peerId, 'real');
    }
  }

  sendWhisperMsg({ isTalking: false }, targetPeerId);
}

// --- public API ---

export function sendTalkingState(isTalking) {
  if (sendTalking) sendTalking(isTalking);
}

export function sendRename(username) {
  if (sendRenameMsg) sendRenameMsg(username);
}

export function toggleKnockMode() {
  if (!state.isCreator) return;
  const enabled = !state.knockEnabled;
  state.knockEnabled = enabled;
  if (sendKnockMsg) {
    sendKnockMsg({ type: 'mode', enabled, creatorId: selfId });
  }
  // Auto-admit all pending knockers when turning off
  if (!enabled && state.pendingKnocks.length > 0) {
    for (const k of state.pendingKnocks) {
      if (sendKnockMsg) {
        sendKnockMsg({ type: 'reply', targetPeerId: k.peerId, approved: true });
      }
      moveKnockToPeers(k.peerId);
    }
    state.pendingKnocks = [];
  }
}

export function approveKnock(peerId) {
  if (sendKnockMsg) {
    sendKnockMsg({ type: 'reply', targetPeerId: peerId, approved: true });
  }
  moveKnockToPeers(peerId);
  state.pendingKnocks = state.pendingKnocks.filter(k => k.peerId !== peerId);
}

export function rejectKnock(peerId) {
  if (sendKnockMsg) {
    sendKnockMsg({ type: 'reply', targetPeerId: peerId, approved: false });
  }
  state.pendingKnocks = state.pendingKnocks.filter(k => k.peerId !== peerId);
}

export async function createRoom() {
  const code = genCode();
  state.isCreator = true;
  state.admitted = true;
  state.creatorId = null; // will be set to selfId after setupRoom
  try { await initAudio(); } catch {
    initAudioContext();
    state.noMic = true;
  }
  setupRoom(code);
  state.creatorId = selfId;
}

export async function joinRoom(code) {
  code = code.toUpperCase().trim();
  if (!code) return;
  state.isCreator = false;
  state.admitted = false;
  try { await initAudio(); } catch {
    initAudioContext();
    state.noMic = true;
  }
  setupRoom(code);
  // Empty room: auto-admit after 3s if no peers respond
  admitTimeout = setTimeout(() => {
    if (!state.admitted) {
      state.isCreator = true;
      state.creatorId = selfId;
      admitSelf();
    }
  }, 3000);
}

function cleanup() {
  for (const el of audioEls.values()) { el.srcObject = null; el.remove(); }
  audioEls.clear();
  peerTrackState.clear();
  activeWhisperTarget = null;
}

export function leaveRoom() {
  cleanup();
  destroyAudio();
  releaseWakeLock();
  if (admitTimeout) { clearTimeout(admitTimeout); admitTimeout = null; }
  pendingPeerInfo.clear();
  if (room) { room.leave(); room = null; }
  sendTalking = null;
  sendWhisperMsg = null;
  sendUsernameMsg = null;
  sendRenameMsg = null;
  sendIdleMsg = null;
  sendKnockMsg = null;
  batch(() => {
    state.peers = [];
    state.isTalking = false;
    state.knockEnabled = false;
    state.admitted = true;
    state.knockWaiting = false;
    state.pendingKnocks = [];
    state.isCreator = false;
    state.creatorId = null;
  });
}
