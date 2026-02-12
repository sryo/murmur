// UI: DOM rendering, PTT event binding
import state, { subscribe } from './state.js';
import { setTalking, getAnalyser, getRemoteAnalyser } from './audio.js';
import { leaveRoom, createRoom, sendTalkingState, startWhisper, stopWhisper, sendRename } from './peer.js';
import { interpolate } from 'https://esm.run/flubber';

const $ = (sel) => document.querySelector(sel);

// --- SVG content (loaded from external files) ---
let earSVG = '';
let mouthSVG = '';
let figureSVG = '';

// Load SVGs at startup
async function loadSVGs() {
  const [earRes, mouthRes, figureRes] = await Promise.all([
    fetch('ear.svg').then(r => r.text()),
    fetch('mouth.svg').then(r => r.text()),
    fetch('figure.svg').then(r => r.text()),
  ]);
  earSVG = earRes;
  mouthSVG = mouthRes;
  figureSVG = figureRes;
}

// Extract inner content from SVG (everything inside the root <svg> tag)
function extractSVGContent(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  return match ? match[1] : svg;
}

// --- System dark mode detection ---

let bgColor = null;
let isDarkMode = false;

function detectSystemDarkMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorFromRoomCode(code) {
  const hue = hashCode(code) % 360;
  const lightness = isDarkMode ? 35 : 50;
  return `hsl(${hue}, 70%, ${lightness}%)`;
}

function setBgColor(color) {
  bgColor = color;
  document.documentElement.style.setProperty('--bg', color);
  document.documentElement.style.setProperty('--stroke-accent', color);

  // Set fill and stroke based on system dark mode
  // Dark mode = black fill, white stroke
  // Light mode = white fill, black stroke
  if (isDarkMode) {
    document.documentElement.style.setProperty('--fill', '#000000');
    document.documentElement.style.setProperty('--stroke', '#FFFFFF');
  } else {
    document.documentElement.style.setProperty('--fill', '#FFFFFF');
    document.documentElement.style.setProperty('--stroke', '#000000');
  }
}

// Listen for system dark mode changes
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    isDarkMode = e.matches;
    if (bgColor && state.roomCode) {
      setBgColor(colorFromRoomCode(state.roomCode));
      render();
    }
  });
}

// --- Dimensions ---
const EAR_WIDTH = 80;
const EAR_HEIGHT = 131;
const MOUTH_WIDTH = 129;
const MOUTH_HEIGHT = 56;

// --- For morphing we need the fill paths ---
const EAR_FILL = `M7.04338 46.5155C7.42547 52.0346 11.8638 59.5402 11.8638 76.7589C11.8638 93.9777 9.5169 98.3883 11.8638 109.872C13.3977 117.377 16.4653 124 26.1068 124C35.7483 124 38.3777 121.793 42.7601 115.391C47.1426 108.989 72.9994 73.4471 72.9994 48.9438C72.9994 24.4405 66.864 7.22182 37.5015 7.00106C8.13899 6.78031 6.6613 40.9964 7.04338 46.5155Z`;
const MOUTH_FILL = `M8.53442 28.5556C8.53442 28.5556 35.8209 7 41.8985 7C47.976 7 54.9797 16.4138 59.6018 15.4444C64.224 14.4751 67.8961 7 72.312 7C76.7279 7 109.534 28.5556 109.534 28.5556C109.534 28.5556 86.3118 49 79.1209 49H37.1322C29.4153 49 8.53442 28.5556 8.53442 28.5556Z`;

// Pre-calculate interpolators for morphing
let earToMouthInterpolator = null;
let mouthToEarInterpolator = null;

try {
  earToMouthInterpolator = interpolate(EAR_FILL, MOUTH_FILL, { maxSegmentLength: 5 });
  mouthToEarInterpolator = interpolate(MOUTH_FILL, EAR_FILL, { maxSegmentLength: 5 });
} catch (e) {
  console.warn('Flubber interpolation setup failed:', e);
}

// --- Peer position slots (percentage-based for 393x852 viewBox) ---
const PEER_SLOTS_PCT = [
  { xPct: 39.95, yPct: 15.96 },  // was { x: 157, y: 136 }
  { xPct: 30.53, yPct: 28.40 },  // was { x: 120, y: 242 }
  { xPct: 76.34, yPct: 19.95 },  // was { x: 300, y: 170 }
  { xPct: 30.53, yPct: 45.77 },  // was { x: 120, y: 390 }
  { xPct: 64.12, yPct: 43.43 },  // was { x: 252, y: 370 }
  { xPct: 69.97, yPct: 57.04 },  // was { x: 275, y: 486 }
  { xPct: 30.53, yPct: 58.69 },  // was { x: 120, y: 500 }
  { xPct: 50.13, yPct: 32.86 },  // was { x: 197, y: 280 }
];

// The mouth position for the user's PTT (percentage-based)
const MY_MOUTH_PCT = { xPct: 50.13, yPct: 70.89 };  // was { x: 197, y: 604 }

// --- Audio-reactive mouth animation ---
// Track animations per peer ID
const mouthAnimations = new Map(); // peerId -> { animationId, smoothedLevel }

function getAudioLevelFromAnalyser(analyser) {
  if (!analyser) return 0;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);

  // Calculate average amplitude
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }
  const avg = sum / dataArray.length;

  // Normalize to 0-1 range (typical speech is 20-80 range)
  return Math.min(1, Math.max(0, (avg - 10) / 60));
}

function getAudioLevel(peerId) {
  // Use local analyser for self, remote analyser for others
  const analyser = (peerId === state.myPeerId)
    ? getAnalyser()
    : getRemoteAnalyser(peerId);
  return getAudioLevelFromAnalyser(analyser);
}

function generateMouthPaths(openness) {
  // openness: 0 = closed, 1 = wide open
  // Move the 5 middle points down, keep corners (points 2 & 5) fixed
  const move = 40 * openness;

  // Point 1: middle right (74.826, 27) -> moves down
  const p1y = 27 + move;
  // Point 3: bottom right (83.2237, 49) -> moves down
  const p3y = 49 + move;
  // Point 4: bottom left (41.235, 49) -> moves down
  const p4y = 49 + move;
  // Point 6: middle left (48.9518, 28.5556) -> moves down
  const p6y = 28.5556 + move;
  // Point 7: middle dip (63.7046, 32.3333) -> moves down
  const p7y = 32.3333 + move;

  // Upper lip (stays fixed)
  const upperPath = `M46.0013 7C39.9237 7 12.6372 28.5556 12.6372 28.5556H48.9518L63.7046 32.3333L74.826 27L113.637 28.5556C113.637 28.5556 80.8306 7 76.4147 7C71.9988 7 68.3268 14.4751 63.7046 15.4444C59.0825 16.4138 52.0788 7 46.0013 7Z`;

  // Lower lip (5 middle points move down)
  const lowerPath = `M74.826 ${p1y}L113.637 28.5556C113.637 28.5556 90.4146 ${p3y} 83.2237 ${p3y}H41.235C33.5181 ${p4y} 12.6372 28.5556 12.6372 28.5556L48.9518 ${p6y}L63.7046 ${p7y}L74.826 ${p1y}Z`;

  return { upperPath, lowerPath };
}

function updateMouthWithAudio(peerId) {
  const animState = mouthAnimations.get(peerId);
  if (!animState) return;

  const level = getAudioLevel(peerId);

  // Smooth the level for more natural movement
  animState.smoothedLevel = animState.smoothedLevel * 0.6 + level * 0.4;

  const { upperPath, lowerPath } = generateMouthPaths(animState.smoothedLevel);

  // Find paths by class and data-peer-id
  const upperFill = document.querySelector(`.mouth-upper[data-peer-id="${peerId}"]`);
  const lowerFill = document.querySelector(`.mouth-lower[data-peer-id="${peerId}"]`);

  if (upperFill) upperFill.setAttribute('d', upperPath);
  if (lowerFill) lowerFill.setAttribute('d', lowerPath);

  animState.animationId = requestAnimationFrame(() => updateMouthWithAudio(peerId));
}

function startMouthAnimation(peerId) {
  if (mouthAnimations.has(peerId)) return;

  const animState = { animationId: null, smoothedLevel: 0 };
  mouthAnimations.set(peerId, animState);
  updateMouthWithAudio(peerId);
}

function stopMouthAnimation(peerId) {
  const animState = mouthAnimations.get(peerId);
  if (!animState) return;

  if (animState.animationId) {
    cancelAnimationFrame(animState.animationId);
  }
  mouthAnimations.delete(peerId);

  // Restore closed mouth
  const { upperPath, lowerPath } = generateMouthPaths(0);

  const upperFill = document.querySelector(`.mouth-upper[data-peer-id="${peerId}"]`);
  const lowerFill = document.querySelector(`.mouth-lower[data-peer-id="${peerId}"]`);

  if (upperFill) upperFill.setAttribute('d', upperPath);
  if (lowerFill) lowerFill.setAttribute('d', lowerPath);
}

// Legacy wrappers for backward compatibility
function startTalkingAnimation() {
  startMouthAnimation(state.myPeerId);
}

function stopTalkingAnimation() {
  stopMouthAnimation(state.myPeerId);
}

// --- inline SVGs ---

const iconShuffle = `<svg viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`;

const iconOffline = `<svg class="icon-offline" viewBox="0 0 24 24"><path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.93 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 12.86a10 10 0 0 1 5.17-2.86"/><circle cx="12" cy="20" r="1"/></svg>`;

const iconMicBlocked = `<svg viewBox="0 0 24 24"><path d="M1 1l22 22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><path d="M19 10v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;

// --- render ---

function renderLoading() {
  return `
    <div class="loading">
      <svg class="loading-icon" viewBox="0 0 24 24"><circle cx="12" cy="14" r="3"/><path d="M8.5 8.5a5 5 0 0 1 7 0"/><path d="M6 6a8.5 8.5 0 0 1 12 0"/></svg>
    </div>`;
}

function renderError() {
  return `
    <div class="error-view">
      <div class="error-icon">${iconMicBlocked}</div>
      <p class="error-msg">Microphone access is blocked.<br>Allow mic permission and try again.</p>
      <button id="btn-retry" class="btn-retry">Try again</button>
    </div>`;
}

function renderRoom() {
  return `
    <div class="room">
      <div class="channel-container">
        <div class="figure-wrapper">
          ${renderFigureSVG()}
          <div class="peer-layer" id="peer-layer">
            ${renderPeerIcons()}
          </div>
        </div>
        ${renderRoomControls()}
      </div>
    </div>`;
}

function renderFigureSVG() {
  // Get the figure content - CSS variables inherited from :root
  const figureContent = extractSVGContent(figureSVG);

  return `
    <svg class="figure-svg" viewBox="0 0 393 852" preserveAspectRatio="none">
      ${figureContent}
    </svg>
  `;
}

function renderPeerIcons() {
  // Separate my peer from others
  const myPeer = state.peers.find(p => p.peerId === state.myPeerId);
  const otherPeers = state.peers.filter(p => p.peerId !== state.myPeerId);

  let html = '';

  // Render other peers (ears/mouths)
  otherPeers.forEach((peer, i) => {
    html += renderPeerIconHTML(peer, PEER_SLOTS_PCT[i % PEER_SLOTS_PCT.length], i);
  });

  // Render my mouth (PTT area)
  if (myPeer) {
    html += renderMyMouthHTML(myPeer);
  }

  return html;
}

// Mouth viewBox: tight bounds with room for animation (mouth opens downward by up to 40px)
const MOUTH_VB_WIDTH = 115;  // x roughly 12-114, plus small padding
const MOUTH_VB_HEIGHT = 90;  // y roughly 7-89 when fully open

function renderDynamicMouthSVG(peerId) {
  const { upperPath, lowerPath } = generateMouthPaths(0);
  const filterId = `filter_${peerId.replace(/[^a-zA-Z0-9]/g, '_')}`;

  return `
    <svg class="peer-svg mouth-svg" viewBox="8 5 ${MOUTH_VB_WIDTH} ${MOUTH_VB_HEIGHT}" preserveAspectRatio="xMidYMid meet">
      <!-- Upper lip -->
      <g filter="url(#${filterId}_upper)">
        <path class="mouth-upper" data-peer-id="${esc(peerId)}" d="${upperPath}" fill="var(--stroke)" stroke="var(--fill)" stroke-width="1"/>
      </g>
      <!-- Lower lip -->
      <g filter="url(#${filterId}_lower)">
        <path class="mouth-lower" data-peer-id="${esc(peerId)}" d="${lowerPath}" fill="var(--stroke)" stroke="var(--fill)" stroke-width="1"/>
      </g>
      <defs>
        <filter id="${filterId}_upper" x="0" y="0" width="130" height="50" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="9888"/>
          <feDisplacementMap in="shape" scale="4" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <filter id="${filterId}_lower" x="0" y="0" width="130" height="100" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="9888"/>
          <feDisplacementMap in="shape" scale="4" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    </svg>
  `;
}

function renderEarSVG() {
  const earContent = extractSVGContent(earSVG);
  return `
    <svg class="peer-svg ear-svg" viewBox="0 0 ${EAR_WIDTH} ${EAR_HEIGHT}" preserveAspectRatio="xMidYMid meet">
      ${earContent}
    </svg>
  `;
}

function renderPeerIconHTML(peer, slot, index) {
  const isTalking = peer.isTalking;
  const name = peer.username || peer.peerId;
  const talkingClass = isTalking ? 'talking' : '';

  // Use dynamic mouth when talking, static ear otherwise
  const svgContent = isTalking
    ? renderDynamicMouthSVG(peer.peerId)
    : renderEarSVG();

  return `
    <div class="peer-icon ${talkingClass}"
         data-peer-id="${esc(peer.peerId)}"
         data-index="${index}"
         data-slot-x-pct="${slot.xPct}"
         data-slot-y-pct="${slot.yPct}"
         style="left: ${slot.xPct}%; top: ${slot.yPct}%;">
      <div class="peer-icon-content">
        ${svgContent}
      </div>
      <span class="peer-label" data-peer-id="${esc(peer.peerId)}">${esc(name)}</span>
    </div>
  `;
}

function renderMyMouthHTML(peer) {
  const slot = MY_MOUTH_PCT;
  const isTalking = peer.isTalking || state.isTalking;
  const name = peer.username || peer.peerId;
  const talkingClass = isTalking ? 'talking' : '';

  return `
    <div class="peer-icon my-mouth ${talkingClass}"
         id="ptt-mouth"
         data-peer-id="${esc(peer.peerId)}"
         data-slot-x-pct="${slot.xPct}"
         data-slot-y-pct="${slot.yPct}"
         style="left: ${slot.xPct}%; top: ${slot.yPct}%;">
      <div class="peer-icon-content">
        ${renderDynamicMouthSVG(peer.peerId, 130, 100)}
      </div>
      <span class="peer-label" data-peer-id="${esc(peer.peerId)}">${esc(name)} (you)</span>
    </div>
  `;
}

function renderRoomControls() {
  return `
    <div class="room-controls">
      <span id="room-code" class="room-code">${esc(state.roomCode)}</span>
      <button id="btn-leave" class="btn-leave" aria-label="New room">
        <svg viewBox="-1 -4 28 30">
          <path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke-width="4" stroke-linecap="square"/>
          <polyline points="10 -2 15 3 10 8" fill="none" stroke-width="4" stroke-linecap="square" stroke-linejoin="miter"/>
        </svg>
      </button>
    </div>
  `;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Peer positions update ---
// With preserveAspectRatio="none", the figure fills the entire container
// so peer-layer just needs to match the container (no offset needed)

function updatePeerPositions() {
  // No special positioning needed - peer-layer uses inset: 0 to match container
  // This function is kept for potential future use
}

// --- Morph animation ---

const morphAnimations = new Map();

function animateMorph(peerId, toTalking) {
  const existing = morphAnimations.get(peerId);
  if (existing) {
    cancelAnimationFrame(existing);
    morphAnimations.delete(peerId);
  }

  const peerIcon = document.querySelector(`.peer-icon[data-peer-id="${peerId}"]`);
  if (!peerIcon) return;

  // Find fill path in the SVG
  const fillPath = peerIcon.querySelector('path[fill^="var(--fill"]');
  if (!fillPath) return;

  const interpolator = toTalking ? earToMouthInterpolator : mouthToEarInterpolator;
  if (!interpolator) {
    updatePeerIcon(peerId);
    return;
  }

  const duration = 300;
  const start = performance.now();

  function tick(now) {
    const elapsed = now - start;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(t);

    try {
      const pathData = interpolator(eased);
      fillPath.setAttribute('d', pathData);
    } catch (e) {
      updatePeerIcon(peerId);
      return;
    }

    if (t < 1) {
      const frame = requestAnimationFrame(tick);
      morphAnimations.set(peerId, frame);
    } else {
      morphAnimations.delete(peerId);
      updatePeerIcon(peerId);
    }
  }

  requestAnimationFrame(tick);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function updatePeerIcon(peerId) {
  const peer = state.peers.find(p => p.peerId === peerId);
  if (!peer) return;

  const peerIcon = document.querySelector(`.peer-icon[data-peer-id="${peerId}"]`);
  if (!peerIcon) return;

  const isTalking = peer.isTalking;

  if (peerId === state.myPeerId) {
    const isActuallyTalking = isTalking || state.isTalking;
    peerIcon.classList.toggle('talking', isActuallyTalking);
    return;
  }

  // Update the SVG content
  const contentWrapper = peerIcon.querySelector('.peer-icon-content');
  if (contentWrapper) {
    const svgContent = isTalking
      ? renderDynamicMouthSVG(peerId)
      : renderEarSVG();
    contentWrapper.innerHTML = svgContent;
  }

  peerIcon.classList.toggle('talking', isTalking);
}

// --- whisper hold ---

function whisperStart(peerId) {
  if (state.isTalking || state.whisperTarget) return;
  navigator.vibrate?.(30);
  state.whisperTarget = peerId;
  startWhisper(peerId);
  // Animate both my mouth and the whisper target's icon
  startMouthAnimation(state.myPeerId);
  startMouthAnimation(peerId);
}

function whisperStop() {
  if (!state.whisperTarget) return;
  const target = state.whisperTarget;
  state.whisperTarget = null;
  stopWhisper(target);
  // Stop animations
  stopMouthAnimation(state.myPeerId);
  stopMouthAnimation(target);
}

// --- name edit ---

let editingName = false;

function startNameEdit() {
  if (editingName) return;

  const myLabel = document.querySelector(`.peer-label[data-peer-id="${state.myPeerId}"]`);
  if (!myLabel) return;

  editingName = true;
  const currentName = state.username;

  // Hide the label while editing
  myLabel.style.opacity = '0';

  // Get the label's position in screen coordinates
  const labelRect = myLabel.getBoundingClientRect();

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.maxLength = 20;
  input.style.cssText = `
    position: fixed;
    left: ${labelRect.left + labelRect.width / 2}px;
    top: ${labelRect.top + labelRect.height / 2}px;
    transform: translate(-50%, -50%);
    padding: 0;
    font-size: ${getComputedStyle(myLabel).fontSize};
    font-weight: 900;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    border: none;
    background: transparent;
    color: var(--stroke);
    text-align: center;
    outline: none;
    z-index: 1000;
  `;

  document.body.appendChild(input);
  input.focus();
  input.select();

  const save = () => {
    if (!editingName) return;
    editingName = false;
    const newName = input.value.trim().slice(0, 20) || currentName;
    input.remove();

    // Restore label visibility
    myLabel.style.opacity = '1';

    if (newName !== currentName) {
      state.username = newName;
      localStorage.setItem('murmur-username', newName);
      state.peers = state.peers.map(p =>
        p.peerId === state.myPeerId ? { ...p, username: newName } : p
      );
      sendRename(newName);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); input.value = currentName; save(); }
  });
  input.addEventListener('blur', () => setTimeout(save, 80));
}

// --- peer icon binding ---

function bindPeerIcons() {
  const icons = document.querySelectorAll('.peer-icon[data-peer-id]');
  for (const icon of icons) {
    const peerId = icon.getAttribute('data-peer-id');

    if (peerId === state.myPeerId) {
      bindPTT(icon);

      const label = icon.querySelector('.peer-label');
      if (label) {
        const trigger = (e) => { e.preventDefault(); e.stopPropagation(); startNameEdit(); };
        label.addEventListener('pointerdown', trigger);
        label.style.cursor = 'pointer';
      }
      continue;
    }

    let activePointerId = null;

    const start = (e) => {
      e.preventDefault();
      // Capture pointer
      if (e.pointerId !== undefined) {
        icon.setPointerCapture(e.pointerId);
        activePointerId = e.pointerId;
      }
      whisperStart(peerId);
    };

    const stop = (e) => {
      e.preventDefault();
      // Release pointer capture
      if (activePointerId !== null && icon.hasPointerCapture(activePointerId)) {
        icon.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
      whisperStop();
    };

    icon.addEventListener('pointerdown', start);
    icon.addEventListener('pointerup', stop);
    icon.addEventListener('pointercancel', stop);
    icon.style.cursor = 'pointer';
    icon.style.touchAction = 'none';
  }
}

// --- PTT binding (on mouth) ---

function bindPTT(element) {
  let activePointerId = null;

  const start = (e) => {
    e.preventDefault();
    if (state.isTalking || state.whisperTarget) return;

    // Capture pointer to prevent losing it when element moves
    if (e.pointerId !== undefined) {
      element.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;
    }

    navigator.vibrate?.(30);
    state.isTalking = true;
    setTalking(true);
    sendTalkingState(true);
    startTalkingAnimation();
    element.classList.add('talking');
  };

  const stop = (e) => {
    e.preventDefault();
    if (!state.isTalking) return;

    // Release pointer capture
    if (activePointerId !== null && element.hasPointerCapture(activePointerId)) {
      element.releasePointerCapture(activePointerId);
    }
    activePointerId = null;

    state.isTalking = false;
    setTalking(false);
    sendTalkingState(false);
    stopTalkingAnimation();
    element.classList.remove('talking');
  };

  // Use pointer events for unified handling
  element.addEventListener('pointerdown', start);
  element.addEventListener('pointerup', stop);
  element.addEventListener('pointercancel', stop);
  // Don't use pointerleave - pointer capture handles this
  element.style.cursor = 'pointer';
  element.style.touchAction = 'none';
}

// --- mount & update ---

let currentView = null;
let lastPeersKey = '';

function peersKey() {
  return state.peers.map(p => `${p.peerId}:${p.username}:${p.isTalking}`).join('|');
}

function getView() {
  if (state.error) return 'error';
  return state.view === 'room' ? 'room' : 'loading';
}

function render() {
  if (state.view === 'room' && state.roomCode) {
    setBgColor(colorFromRoomCode(state.roomCode));
  }

  const app = $('#app');
  const view = getView();
  app.innerHTML = view === 'room' ? renderRoom() : view === 'error' ? renderError() : renderLoading();
  currentView = view;
  lastPeersKey = peersKey();
  bind();

  // Update peer positions after render and manage filter animation
  if (view === 'room') {
    requestAnimationFrame(() => {
      updatePeerPositions();
    });
    startFilterSeedAnimation();
  } else {
    stopFilterSeedAnimation();
  }
}

async function transitionToNewRoom() {
  const currentRoom = document.querySelector('.room');
  if (!currentRoom) {
    leaveRoom();
    return;
  }

  // Slide out current room
  currentRoom.classList.add('slide-out');

  // Wait for slide-out animation
  await new Promise(r => setTimeout(r, 400));

  // Leave and create new room (color will be set from new room code)
  leaveRoom();

  // After render, add slide-in class
  requestAnimationFrame(() => {
    const newRoom = document.querySelector('.room');
    if (newRoom) {
      newRoom.classList.add('slide-in');
      setTimeout(() => newRoom.classList.remove('slide-in'), 400);
    }
  });
}

function bindRoomControls() {
  $('#room-code')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#room=${state.roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      const el = $('#room-code');
      if (el) {
        const orig = el.textContent;
        el.textContent = 'Copied';
        setTimeout(() => { el.textContent = orig; }, 2000);
      }
    }).catch(() => {});
  });

  $('#btn-leave')?.addEventListener('click', transitionToNewRoom);
}

function bind() {
  if (getView() === 'error') {
    $('#btn-retry')?.addEventListener('click', () => {
      state.error = null;
      createRoom();
    });
    return;
  }
  if (getView() !== 'room') return;

  bindPeerIcons();
  bindRoomControls();
}

// --- global keyboard ---
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || state.view !== 'room') return;
  e.preventDefault();
  if (!state.isTalking && !state.whisperTarget) {
    state.isTalking = true;
    setTalking(true);
    sendTalkingState(true);
    startTalkingAnimation();
    const myMouth = document.querySelector('.my-mouth');
    if (myMouth) myMouth.classList.add('talking');
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || state.view !== 'room') return;
  e.preventDefault();
  if (state.isTalking) {
    state.isTalking = false;
    setTalking(false);
    sendTalkingState(false);
    stopTalkingAnimation();
    const myMouth = document.querySelector('.my-mouth');
    if (myMouth) myMouth.classList.remove('talking');
  }
});

// --- Track previous talking states for morph animation ---
const prevTalkingStates = new Map();

// --- subscriptions ---

const fullRenderProps = new Set(['view', 'roomCode', 'error', 'offline']);

subscribe((prop) => {
  const view = getView();
  if (view !== currentView) { render(); return; }
  if (fullRenderProps.has(prop)) { render(); return; }

  if (prop === 'peers') {
    const peerLayer = $('#peer-layer');
    if (!peerLayer) return;
    if (editingName) return;

    const key = peersKey();
    if (key !== lastPeersKey) {
      // Track which peers changed talking state
      const peersToStartAnim = [];
      const peersToStopAnim = [];

      for (const peer of state.peers) {
        const wasTalking = prevTalkingStates.get(peer.peerId) || false;
        const isTalking = !!peer.isTalking;

        if (wasTalking !== isTalking && peer.peerId !== state.myPeerId) {
          setTimeout(() => animateMorph(peer.peerId, isTalking), 0);
          // Queue animation start/stop for after DOM render
          if (isTalking) {
            peersToStartAnim.push(peer.peerId);
          } else {
            peersToStopAnim.push(peer.peerId);
          }
        }
        prevTalkingStates.set(peer.peerId, isTalking);
      }

      // Stop animations before re-render
      for (const peerId of peersToStopAnim) {
        stopMouthAnimation(peerId);
      }

      // Re-render peer icons
      peerLayer.innerHTML = renderPeerIcons();
      bindPeerIcons();
      lastPeersKey = key;

      // Update positions and start animations after DOM is ready
      requestAnimationFrame(() => {
        updatePeerPositions();
        for (const peerId of peersToStartAnim) {
          startMouthAnimation(peerId);
        }
      });
      return;
    }
    return;
  }

  if (prop === 'whisperTarget') {
    return;
  }

  if (prop === 'isTalking') {
    const myMouth = document.querySelector('.my-mouth');
    if (myMouth) {
      myMouth.classList.toggle('talking', state.isTalking);
    }
    return;
  }
});

// --- Window resize handler ---
window.addEventListener('resize', () => {
  if (state.view === 'room') {
    updatePeerPositions();
  }
});

// --- SVG filter seed animation ---
let filterSeedInterval = null;

function startFilterSeedAnimation() {
  if (filterSeedInterval) return;
  filterSeedInterval = setInterval(() => {
    const turbulenceElements = document.querySelectorAll('feTurbulence');
    const filteredElements = document.querySelectorAll('[filter]');

    for (const el of turbulenceElements) {
      el.setAttribute('seed', Math.floor(Math.random() * 10000));
    }

    // Force repaint by toggling filter reference
    for (const el of filteredElements) {
      const filter = el.getAttribute('filter');
      el.removeAttribute('filter');
      // Force reflow
      void el.offsetWidth;
      el.setAttribute('filter', filter);
    }
  }, 200);
}

function stopFilterSeedAnimation() {
  if (filterSeedInterval) {
    clearInterval(filterSeedInterval);
    filterSeedInterval = null;
  }
}

// --- offline detection ---

window.addEventListener('offline', () => { state.offline = true; });
window.addEventListener('online', () => { state.offline = false; });

export async function initUI() {
  // Initialize dark mode before anything else
  isDarkMode = detectSystemDarkMode();
  await loadSVGs();
  render();
}
