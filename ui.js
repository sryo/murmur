// Declarative UI: one render path (lit-html), keyed peer nodes, event bindings.
import { render, html } from 'https://esm.run/lit-html@3.3.3';
import { repeat } from 'https://esm.run/lit-html@3.3.3/directives/repeat.js';
import { unsafeSVG } from 'https://esm.run/lit-html@3.3.3/directives/unsafe-svg.js';
import state, { subscribe, updatePeer, isActive } from './state.js';
import { setTalking } from './audio.js';
import {
  leaveRoom, createRoom, sendTalkingState, startWhisper, stopWhisper,
  sendRename, toggleKnockMode, resolveKnock,
} from './net.js';
import {
  loadSVGs, getEarSVG, getFigureSVG, extractSVGContent,
  CLOSED_MOUTH, MOUTH_VB_WIDTH, MOUTH_VB_HEIGHT, FILTER_SCALE, hashCode,
  detectSystemDarkMode, setDarkMode, applyTheme,
} from './svg.js';
import { syncAnimations, startFilterTexture, stopFilterTexture } from './animate.js';

// --- layout constants ---
const EAR_WIDTH = 80;
const EAR_HEIGHT = 131;
const PEER_BOUNDS = { xMin: 22, xMax: 78, yMin: 15, yMax: 55 };
const MY_MOUTH_PCT = { xPct: 50, yPct: 72 };

// Views that show the figure + animated grain (vs loading/error)
const ROOM_VIEWS = new Set(['room', 'knocking', 'rejected']);

function seededRandom(seed) {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
}

// Deterministic peer placement with spring repulsion, kept clear of the PTT mouth.
// The physics depend only on the peer set, so memoize by it — renders fire on every
// talking/idle toggle and must not re-run the O(n²)×15 solver each time.
const positionCache = { key: '', byId: new Map() };

function calculatePeerPositions(peerIds) {
  if (!peerIds.length) return [];
  const key = [...peerIds].sort().join(',');
  if (key !== positionCache.key) {
    positionCache.key = key;
    positionCache.byId = computePositionsById(peerIds);
  }
  return peerIds.map(id => positionCache.byId.get(id));
}

function computePositionsById(peerIds) {
  const { xMin, xMax, yMin, yMax } = PEER_BOUNDS;
  const sorted = [...peerIds].sort();
  let positions = sorted.map(id => {
    const seed = hashCode(id);
    return {
      xPct: xMin + (xMax - xMin) * seededRandom(seed),
      yPct: yMin + (yMax - yMin) * seededRandom(seed + 1),
    };
  });

  for (let iter = 0; iter < 15; iter++) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[j].xPct - positions[i].xPct;
        const dy = positions[j].yPct - positions[i].yPct;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        if (dist < 20) {
          const push = (20 - dist) / 2;
          const nx = dx / dist, ny = dy / dist;
          positions[i].xPct -= nx * push; positions[i].yPct -= ny * push;
          positions[j].xPct += nx * push; positions[j].yPct += ny * push;
        }
      }
      const dx = positions[i].xPct - MY_MOUTH_PCT.xPct;
      const dy = positions[i].yPct - MY_MOUTH_PCT.yPct;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
      if (dist < 40) {
        const push = 40 - dist;
        positions[i].xPct += (dx / dist) * push;
        positions[i].yPct += (dy / dist) * push;
      }
    }
    positions = positions.map(p => ({
      xPct: Math.max(xMin, Math.min(xMax, p.xPct)),
      yPct: Math.max(yMin, Math.min(yMax, p.yPct)),
    }));
  }
  const byId = new Map();
  sorted.forEach((id, i) => byId.set(id, positions[i]));
  return byId;
}

// --- icons ---
const iconMicBlocked = html`<svg viewBox="0 0 24 24"><path d="M1 1l22 22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><path d="M19 10v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
const iconLockOpen = html`<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11"/><path d="M7 11V7a5 5 0 0 1 10 0" fill="none"/></svg>`;
const iconLockClosed = html`<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11"/><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none"/></svg>`;
const iconCheck = html`<svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"/></svg>`;
const iconCross = html`<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;

// --- svg sub-templates ---
function figureSVGTemplate() {
  return html`<svg class="figure-svg" viewBox="0 0 393 852" preserveAspectRatio="none">${unsafeSVG(extractSVGContent(getFigureSVG()))}</svg>`;
}

function earSVGTemplate() {
  return html`<svg class="peer-svg ear-svg" viewBox="0 0 ${EAR_WIDTH} ${EAR_HEIGHT}" preserveAspectRatio="xMidYMid meet">${unsafeSVG(extractSVGContent(getEarSVG()))}</svg>`;
}

// Closed-mouth SVG with per-peer turbulence filters. animate.js owns the `d` after first paint.
function mouthSVGTemplate(peerId) {
  const fid = `filter_${peerId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return html`
    <svg class="peer-svg mouth-svg" viewBox="8 5 ${MOUTH_VB_WIDTH} ${MOUTH_VB_HEIGHT}" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#${fid}_upper)">
        <path class="mouth-upper" data-peer-id=${peerId} d=${CLOSED_MOUTH.upperPath} fill="var(--stroke)" stroke="var(--fill)" stroke-width="1"/>
      </g>
      <g filter="url(#${fid}_lower)">
        <path class="mouth-lower" data-peer-id=${peerId} d=${CLOSED_MOUTH.lowerPath} fill="var(--stroke)" stroke="var(--fill)" stroke-width="1"/>
      </g>
      <defs>
        <filter id="${fid}_upper" x="0" y="0" width="130" height="50" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="9888"/>
          <feDisplacementMap in="shape" scale=${FILTER_SCALE} xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <filter id="${fid}_lower" x="0" y="0" width="130" height="100" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="9888"/>
          <feDisplacementMap in="shape" scale=${FILTER_SCALE} xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    </svg>`;
}

// --- PTT / whisper / rename handlers ---
function pttDown(e) {
  e.preventDefault();
  if (state.noMic || state.editingName || state.isTalking || state.whisperTarget) return;
  e.currentTarget.setPointerCapture?.(e.pointerId);
  navigator.vibrate?.(30);
  state.isTalking = true;
  setTalking(true);
  sendTalkingState(true);
}

function pttUp(e) {
  e.preventDefault();
  if (!state.isTalking) return;
  try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
  state.isTalking = false;
  setTalking(false);
  sendTalkingState(false);
}

function whisperDown(e, peerId) {
  e.preventDefault();
  if (state.noMic || state.isTalking || state.whisperTarget) return;
  e.currentTarget.setPointerCapture?.(e.pointerId);
  navigator.vibrate?.(30);
  startWhisper(peerId);
}

function whisperUp(e) {
  e.preventDefault();
  if (!state.whisperTarget) return;
  try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
  stopWhisper(state.whisperTarget);
}

function labelDown(e) {
  e.preventDefault();
  e.stopPropagation();
  state.editingName = true;
}

function nameCommit() {
  if (!state.editingName) return;
  const input = document.getElementById('name-input');
  const current = state.username;
  const newName = (input?.value.trim().slice(0, 20)) || current;
  state.editingName = false;
  if (newName !== current) {
    state.username = newName;
    localStorage.setItem('murmur-username', newName);
    updatePeer(state.myPeerId, { username: newName });
    sendRename(newName);
  }
}

function nameKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); nameCommit(); }
  else if (e.key === 'Escape') { e.preventDefault(); state.editingName = false; }
}

// --- room controls ---
let showCopied = false;

function copyLink() {
  const url = `${location.origin}${location.pathname}#room=${state.roomCode}`;
  navigator.clipboard.writeText(url).then(() => {
    showCopied = true;
    scheduleRender();
    setTimeout(() => { showCopied = false; scheduleRender(); }, 2000);
  }).catch(() => {});
}

let renderPaused = false;

async function newRoom() {
  const roomEl = document.querySelector('.room');
  if (!roomEl) { leaveRoom(); createRoom(); return; }
  renderPaused = true;
  roomEl.classList.add('slide-out');
  await new Promise(r => setTimeout(r, 400));
  renderPaused = false;
  leaveRoom();
  await createRoom();
  requestAnimationFrame(() => {
    const el = document.querySelector('.room');
    if (el) { el.classList.remove('slide-out'); el.classList.add('slide-in'); setTimeout(() => el.classList.remove('slide-in'), 400); }
  });
}

// --- templates ---
function peerIconTemplate(peer, slot) {
  const active = isActive(peer);
  const cls = `peer-icon ${active ? 'talking' : ''} ${peer.isIdle ? 'idle' : ''}`;
  return html`
    <div class=${cls} data-peer-id=${peer.peerId}
         style="left:${slot.xPct}%;top:${slot.yPct}%;touch-action:none"
         @pointerdown=${e => whisperDown(e, peer.peerId)}
         @pointerup=${whisperUp} @pointercancel=${whisperUp}>
      <div class="peer-icon-content">${active ? mouthSVGTemplate(peer.peerId) : earSVGTemplate()}</div>
      <span class="peer-label" data-peer-id=${peer.peerId}>${peer.username || peer.peerId}</span>
    </div>`;
}

function myMouthTemplate(peer) {
  const cls = `peer-icon my-mouth ${peer.isTalking || state.isTalking ? 'talking' : ''} ${peer.isIdle ? 'idle' : ''} ${state.noMic ? 'no-mic' : ''}`;
  const name = peer.username || peer.peerId;
  return html`
    <div class=${cls} id="ptt-mouth" data-peer-id=${peer.peerId}
         style="left:${MY_MOUTH_PCT.xPct}%;top:${MY_MOUTH_PCT.yPct}%"
         @pointerdown=${pttDown} @pointerup=${pttUp} @pointercancel=${pttUp}>
      <div class="peer-icon-content">${mouthSVGTemplate(peer.peerId)}</div>
      ${state.editingName
        ? html`<input id="name-input" class="peer-label name-input" maxlength="20" .value=${state.username}
                 @keydown=${nameKeydown} @blur=${nameCommit} @pointerdown=${e => e.stopPropagation()}>`
        : html`<span class="peer-label" data-peer-id=${peer.peerId} @pointerdown=${labelDown}>${name} (you)</span>`}
    </div>`;
}

function peerLayerTemplate() {
  const me = state.peers.find(p => p.peerId === state.myPeerId);
  const others = state.peers.filter(p => p.peerId !== state.myPeerId);
  const positions = calculatePeerPositions(others.map(p => p.peerId));
  return html`
    ${repeat(others, p => p.peerId, (p, i) => peerIconTemplate(p, positions[i]))}
    ${me ? myMouthTemplate(me) : ''}`;
}

function roomControlsTemplate() {
  let lock = '';
  if (state.creatorId === state.myPeerId) {
    lock = html`<button class="btn-lock ${state.knockEnabled ? 'active' : ''}" aria-label="Toggle knock mode"
                 @click=${toggleKnockMode}>${state.knockEnabled ? iconLockClosed : iconLockOpen}</button>`;
  } else if (state.knockEnabled) {
    lock = html`<span class="lock-indicator">${iconLockClosed}</span>`;
  }
  return html`
    <div class="room-controls">
      <span class="room-code" @click=${copyLink}>${showCopied ? 'Copied' : state.roomCode}</span>
      ${lock}
      <button class="btn-leave" aria-label="New room" @click=${newRoom}>
        <svg viewBox="-1 -4 28 30">
          <path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke-width="4" stroke-linecap="square"/>
          <polyline points="10 -2 15 3 10 8" fill="none" stroke-width="4" stroke-linecap="square" stroke-linejoin="miter"/>
        </svg>
      </button>
    </div>`;
}

function knockNotificationsTemplate() {
  if (!state.pendingKnocks.length) return '';
  return html`
    <div class="knock-notifications">
      ${repeat(state.pendingKnocks, k => k.peerId, k => html`
        <div class="knock-notification">
          <span class="knock-name">${k.username || k.peerId}</span>
          <div class="knock-actions">
            <button class="knock-approve" @click=${() => resolveKnock(k.peerId, true)}>${iconCheck}</button>
            <button class="knock-reject" @click=${() => resolveKnock(k.peerId, false)}>${iconCross}</button>
          </div>
        </div>`)}
    </div>`;
}

function roomTemplate() {
  return html`
    <div class="room">
      <div class="channel-container">
        <div class="figure-wrapper">
          ${figureSVGTemplate()}
          <div class="peer-layer" id="peer-layer">${peerLayerTemplate()}</div>
        </div>
        ${roomControlsTemplate()}
      </div>
      ${knockNotificationsTemplate()}
    </div>`;
}

function knockScreenTemplate(message) {
  return html`
    <div class="room knocking">
      <div class="channel-container">
        <div class="figure-wrapper">
          ${figureSVGTemplate()}
          <div class="peer-layer">
            <div class="knock-mouth-icon">${mouthSVGTemplate('knock')}</div>
          </div>
        </div>
      </div>
      <div class="knock-overlay">${message}</div>
    </div>`;
}

const knockingTemplate = () => knockScreenTemplate(
  html`<div class="knock-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`);
const rejectedTemplate = () => knockScreenTemplate(html`<p class="knocking-msg">no</p>`);

const loadingTemplate = () => html`
  <div class="loading">
    <svg class="loading-icon" viewBox="0 0 24 24"><circle cx="12" cy="14" r="3"/><path d="M8.5 8.5a5 5 0 0 1 7 0"/><path d="M6 6a8.5 8.5 0 0 1 12 0"/></svg>
  </div>`;

const errorTemplate = () => html`
  <div class="error-view">
    <div class="error-icon">${iconMicBlocked}</div>
    <p class="error-msg">Microphone access is blocked.<br>Allow mic permission and try again.</p>
    <button class="btn-retry" @click=${() => { state.error = null; createRoom(); }}>Try again</button>
  </div>`;

function appTemplate() {
  if (state.error) return errorTemplate();
  if (state.view === 'knocking') return knockingTemplate();
  if (state.view === 'rejected') return rejectedTemplate();
  if (state.view === 'room') return roomTemplate();
  return loadingTemplate();
}

// --- render scheduling: one path, rAF-coalesced ---
let scheduled = false;
let appliedTheme = null; // last roomCode pushed to CSS vars; reset on dark-mode change

function scheduleRender() {
  if (scheduled || renderPaused) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; if (!renderPaused) renderNow(); });
}

function renderNow() {
  const roomish = ROOM_VIEWS.has(state.view);
  if (roomish && state.roomCode && state.roomCode !== appliedTheme) {
    applyTheme(state.roomCode);
    appliedTheme = state.roomCode;
  }

  render(appTemplate(), document.getElementById('app'));

  if (roomish) startFilterTexture(); else stopFilterTexture();
  syncAnimations();

  if (state.editingName) {
    const input = document.getElementById('name-input');
    if (input && document.activeElement !== input) { input.focus(); input.select(); }
  }
}

// --- global listeners (bound once) ---
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.repeat || state.view !== 'room' || state.editingName) return;
  e.preventDefault();
  if (state.noMic || state.isTalking || state.whisperTarget) return;
  state.isTalking = true;
  setTalking(true);
  sendTalkingState(true);
});
document.addEventListener('keyup', e => {
  if (e.code !== 'Space' || state.view !== 'room' || !state.isTalking) return;
  e.preventDefault();
  state.isTalking = false;
  setTalking(false);
  sendTalkingState(false);
});

for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, e => e.preventDefault(), { passive: false });
}

window.addEventListener('offline', () => { state.offline = true; });
window.addEventListener('online', () => { state.offline = false; });

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    setDarkMode(e.matches);
    appliedTheme = null; // dark mode flips fill/stroke — force theme re-apply
    scheduleRender();
  });
}

subscribe(scheduleRender);

export async function initUI() {
  setDarkMode(detectSystemDarkMode());
  await loadSVGs();
  renderNow();
}
