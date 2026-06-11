// Single reactive store. Proxy notifies on reference change only:
// always replace arrays/objects, never mutate in place (use the helpers below).

function genName() {
  return 'User-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

const initial = {
  view: 'loading',        // 'loading' | 'room' | 'knocking' | 'rejected' | 'error'
  error: null,
  offline: !navigator.onLine,
  username: localStorage.getItem('murmur-username') || genName(),
  roomCode: '',
  myPeerId: '',
  peers: [],              // { peerId, username, isTalking, isWhispering, isIdle }
  isTalking: false,
  whisperTarget: null,    // peerId currently being whispered to
  editingName: false,
  noMic: false,
  knockEnabled: false,
  admitted: true,
  pendingKnocks: [],      // { peerId, username }
  creatorId: null,
};

// Persist username so it survives refresh
localStorage.setItem('murmur-username', initial.username);

const subscribers = new Set();
let batching = false;
let pendingChanges = [];

function notify(prop, value, oldValue) {
  if (batching) {
    pendingChanges.push({ prop, value, oldValue });
    return;
  }
  for (const fn of subscribers) fn(prop, value, oldValue);
}

const state = new Proxy({ ...initial }, {
  set(target, prop, value) {
    const old = target[prop];
    if (old === value) return true;
    target[prop] = value;
    notify(prop, value, old);
    return true;
  },
});

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function batch(fn) {
  batching = true;
  fn();
  batching = false;
  const changes = pendingChanges;
  pendingChanges = [];
  const latest = new Map();
  for (const c of changes) {
    if (latest.has(c.prop)) latest.get(c.prop).value = c.value;
    else latest.set(c.prop, { prop: c.prop, oldValue: c.oldValue, value: c.value });
  }
  for (const { prop, value, oldValue } of latest.values()) {
    for (const fn of subscribers) fn(prop, value, oldValue);
  }
}

// --- peer helpers (immutable updates so the Proxy notifies) ---

export function makePeer(peerId, username) {
  return { peerId, username: username || peerId, isTalking: false, isWhispering: false, isIdle: false };
}

export function upsertPeer(peerId, username) {
  if (state.peers.some(p => p.peerId === peerId)) return;
  state.peers = [...state.peers, makePeer(peerId, username)];
}

export function updatePeer(peerId, patch) {
  state.peers = state.peers.map(p => (p.peerId === peerId ? { ...p, ...patch } : p));
}

export function removePeer(peerId) {
  state.peers = state.peers.filter(p => p.peerId !== peerId);
}

export default state;
