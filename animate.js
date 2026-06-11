// Imperative high-frequency animation: audio-reactive mouths + filter grain.
// Runs on the stable keyed nodes lit-html renders; never goes through lit-html itself.
import state, { isActive } from './state.js';
import { getAnalyser, getRemoteAnalyser } from './audio.js';
import { generateMouthPaths, CLOSED_MOUTH } from './svg.js';

// peerId -> { rafId, smoothed, buf, upper, lower } — buf and node refs cached across frames
const animations = new Map();

function audioLevel(peerId, anim) {
  const analyser = peerId === state.myPeerId ? getAnalyser() : getRemoteAnalyser(peerId);
  if (!analyser) return 0;
  if (!anim.buf || anim.buf.length !== analyser.frequencyBinCount) {
    anim.buf = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(anim.buf);
  let sum = 0;
  for (let i = 0; i < anim.buf.length; i++) sum += anim.buf[i];
  const avg = sum / anim.buf.length;
  return Math.min(1, Math.max(0, (avg - 10) / 60)); // typical speech ~20-80
}

// Cache the mouth path nodes on the anim state; re-query only if they were re-rendered
function mouthNodes(peerId, anim) {
  if (!anim.upper?.isConnected || !anim.lower?.isConnected) {
    const sel = CSS.escape(peerId);
    anim.upper = document.querySelector(`.mouth-upper[data-peer-id="${sel}"]`);
    anim.lower = document.querySelector(`.mouth-lower[data-peer-id="${sel}"]`);
  }
  return anim;
}

function setMouth(peerId, anim, openness) {
  const { upper, lower } = mouthNodes(peerId, anim);
  if (!upper && !lower) return;
  const { upperPath, lowerPath } = generateMouthPaths(openness);
  if (upper) upper.setAttribute('d', upperPath);
  if (lower) lower.setAttribute('d', lowerPath);
}

function tick(peerId) {
  const anim = animations.get(peerId);
  if (!anim) return;
  anim.smoothed = anim.smoothed * 0.6 + audioLevel(peerId, anim) * 0.4;
  setMouth(peerId, anim, anim.smoothed);
  anim.rafId = requestAnimationFrame(() => tick(peerId));
}

function startMouthAnimation(peerId) {
  if (animations.has(peerId)) return;
  animations.set(peerId, { rafId: null, smoothed: 0, buf: null, upper: null, lower: null });
  tick(peerId);
}

function stopMouthAnimation(peerId) {
  const anim = animations.get(peerId);
  if (!anim) return;
  if (anim.rafId) cancelAnimationFrame(anim.rafId);
  animations.delete(peerId);
  const { upper, lower } = mouthNodes(peerId, anim);
  if (upper) upper.setAttribute('d', CLOSED_MOUTH.upperPath);
  if (lower) lower.setAttribute('d', CLOSED_MOUTH.lowerPath);
}

// Reconcile running animations with current state. Call after each render.
export function syncAnimations() {
  const shouldAnimate = new Set();
  for (const p of state.peers) {
    const active = p.peerId === state.myPeerId
      ? (state.isTalking || state.whisperTarget)
      : isActive(p);
    if (active) shouldAnimate.add(p.peerId);
  }
  for (const peerId of animations.keys()) {
    if (!shouldAnimate.has(peerId)) stopMouthAnimation(peerId);
  }
  for (const peerId of shouldAnimate) startMouthAnimation(peerId);
}

// --- filter grain: re-seed turbulence on an interval for a living-texture look ---

let filterInterval = null;

export function startFilterTexture() {
  if (filterInterval) return;
  filterInterval = setInterval(() => {
    const turbulence = document.querySelectorAll('feTurbulence');
    const filtered = document.querySelectorAll('[filter]');
    if (!turbulence.length) return;
    for (const el of turbulence) el.setAttribute('seed', Math.floor(Math.random() * 10000));
    // Nudge a repaint (Safari ignores bare seed changes). Batch into one reflow.
    const saved = [];
    for (const el of filtered) { saved.push([el, el.getAttribute('filter')]); el.removeAttribute('filter'); }
    void document.body.offsetWidth;
    for (const [el, filter] of saved) el.setAttribute('filter', filter);
  }, 200);
}

export function stopFilterTexture() {
  if (filterInterval) { clearInterval(filterInterval); filterInterval = null; }
}
