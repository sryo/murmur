// Proxy-based reactive store with subscribe and batch

function genName() {
  return 'User-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

const initial = {
  view: 'loading',
  error: null,
  offline: !navigator.onLine,
  username: localStorage.getItem('murmur-username') || genName(),
  roomCode: '',
  myPeerId: '',
  peers: [],
  isTalking: false,
  whisperTarget: null,
  noMic: false,
  knockEnabled: false,
  admitted: true,
  knockWaiting: false,
  pendingKnocks: [],
  isCreator: false,
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
  const changes = pendingChanges.slice();
  pendingChanges = [];
  const map = new Map();
  for (const c of changes) {
    if (map.has(c.prop)) map.get(c.prop).value = c.value;
    else map.set(c.prop, { prop: c.prop, oldValue: c.oldValue, value: c.value });
  }
  for (const { prop, value, oldValue } of map.values()) {
    for (const sub of subscribers) sub(prop, value, oldValue);
  }
}

export default state;
