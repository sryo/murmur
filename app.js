// Entry: auto-create or auto-join, SW registration
import { createRoom, joinRoom } from './peer.js';
import { initUI } from './ui.js';

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Boot
async function boot() {
  await initUI();

  const match = location.hash.match(/^#room=([A-Z0-9]{4})$/i);
  if (match) {
    joinRoom(match[1].toUpperCase());
  } else {
    createRoom();
  }
}

boot();
