// Entry: boot, SW registration, hash-based room routing
import { createRoom, joinRoom, leaveRoom } from './net.js';
import { initUI } from './ui.js';
import state from './state.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function getRoomFromHash() {
  const match = location.hash.match(/^#room=([A-Z0-9]{4})$/i);
  return match ? match[1].toUpperCase() : null;
}

window.addEventListener('hashchange', () => {
  const newRoom = getRoomFromHash();
  if (newRoom && newRoom !== state.roomCode) {
    leaveRoom();
    joinRoom(newRoom);
  }
});

async function boot() {
  await initUI();
  const room = getRoomFromHash();
  if (room) joinRoom(room);
  else createRoom();
}

boot();
