// Trystero: decentralized room API, mesh networking, data actions
import state, { batch } from './state.js';
import { getStream, initAudio, destroyAudio, getRealTrack, getSilentTrack, createRemoteAnalyser, removeRemoteAnalyser } from './audio.js';
import { joinRoom as trysteroJoin, selfId } from 'https://esm.run/trystero/nostr';

const APP_ID = 'murmur-ptt';
let room = null;
let sendTalking = null;
let sendWhisperMsg = null;
let sendUsernameMsg = null;
let sendRenameMsg = null;
const peerTrackState = new Map(); // peerId -> 'real' | 'silent'
let activeWhisperTarget = null;
const audioEls = new Map();

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

  // Set self state
  batch(() => {
    state.myPeerId = selfId;
    state.roomCode = code;
    state.view = 'room';
    state.peers = [{ peerId: selfId, username: state.username, isTalking: false }];
  });
  location.hash = `room=${code}`;

  // Receive handlers
  getUsername((username, peerId) => {
    updatePeer(peerId, { username });
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

  // Peer lifecycle
  room.onPeerJoin(peerId => {
    if (!state.peers.find(p => p.peerId === peerId)) {
      state.peers = [...state.peers, { peerId, username: peerId, isTalking: false }];
    }
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
  });

  room.onPeerLeave(peerId => {
    state.peers = state.peers.filter(p => p.peerId !== peerId);
    removeRemoteAudio(peerId);
    peerTrackState.delete(peerId);
  });

  room.onPeerStream((stream, peerId) => {
    playRemoteStream(peerId, stream);
  });

  requestWakeLock();
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

export async function createRoom() {
  const code = genCode();
  try { await initAudio(); } catch (e) {
    state.error = 'mic';
    return;
  }
  setupRoom(code);
}

export async function joinRoom(code) {
  code = code.toUpperCase().trim();
  if (!code) return;
  try { await initAudio(); } catch (e) {
    state.error = 'mic';
    return;
  }
  setupRoom(code);
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
  if (room) { room.leave(); room = null; }
  sendTalking = null;
  sendWhisperMsg = null;
  sendUsernameMsg = null;
  sendRenameMsg = null;
  batch(() => {
    state.peers = [];
    state.isTalking = false;
  });
  createRoom();
}
