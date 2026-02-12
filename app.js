// Entry: auto-create or auto-join, SW registration
import { createRoom, joinRoom, leaveRoom } from './peer.js';
import { initUI } from './ui.js';
import state from './state.js';

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function getRoomFromHash() {
  const match = location.hash.match(/^#room=([A-Z0-9]{4})$/i);
  return match ? match[1].toUpperCase() : null;
}

function handleHashChange() {
  const newRoom = getRoomFromHash();
  if (newRoom && newRoom !== state.roomCode) {
    leaveRoom();
    joinRoom(newRoom);
  }
}

// Boot
async function boot() {
  await initUI();

  const room = getRoomFromHash();
  if (room) {
    joinRoom(room);
  } else {
    createRoom();
  }
}

window.addEventListener('hashchange', handleHashChange);
boot();
