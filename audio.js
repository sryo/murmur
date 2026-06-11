// Mic capture, PTT track toggle, analysers, silent track for whisper isolation

const ANALYSER = { fftSize: 128, smoothingTimeConstant: 0.5 };
const GUM_TIMEOUT_MS = 8000;

let localStream = null;
let audioCtx = null;
let analyser = null;
let silentTrack = null;
let initPromise = null;
const remoteAnalysers = new Map();

export function initAudioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
}

function makeAnalyser() {
  const a = audioCtx.createAnalyser();
  a.fftSize = ANALYSER.fftSize;
  a.smoothingTimeConstant = ANALYSER.smoothingTimeConstant;
  return a;
}

export function initAudio() {
  if (initPromise) return initPromise;
  initPromise = _initAudio().finally(() => { initPromise = null; });
  return initPromise;
}

async function _initAudio() {
  const gum = navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  // Only time-box when permission is already granted (device acquisition should be quick).
  // When the browser is still prompting, let the user deliberate — don't force noMic on them.
  let prompting = false;
  try {
    prompting = (await navigator.permissions.query({ name: 'microphone' })).state === 'prompt';
  } catch {}

  const stream = await (prompting
    ? gum
    : Promise.race([
        gum,
        new Promise((_, reject) => setTimeout(() => reject(new Error('mic-timeout')), GUM_TIMEOUT_MS)),
      ]));

  localStream = stream;
  for (const track of localStream.getAudioTracks()) track.enabled = false;

  initAudioContext();
  analyser = makeAnalyser();
  audioCtx.createMediaStreamSource(localStream).connect(analyser);
}

export const getStream = () => localStream;
export const getRealTrack = () => (localStream ? localStream.getAudioTracks()[0] : null);
export const getAnalyser = () => analyser;

export function createRemoteAnalyser(peerId, stream) {
  removeRemoteAnalyser(peerId);
  if (!audioCtx) return null;
  const source = audioCtx.createMediaStreamSource(stream);
  const an = makeAnalyser();
  source.connect(an);
  remoteAnalysers.set(peerId, { source, analyser: an });
  return an;
}

export function getRemoteAnalyser(peerId) {
  return remoteAnalysers.get(peerId)?.analyser ?? null;
}

export function removeRemoteAnalyser(peerId) {
  const entry = remoteAnalysers.get(peerId);
  if (entry) {
    entry.source.disconnect();
    remoteAnalysers.delete(peerId);
  }
}

// Silent track: a muted oscillator stream, swapped in to hide audio from non-whisper peers
export function getSilentTrack() {
  if (silentTrack) return silentTrack;
  if (!audioCtx) return null;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  const dest = audioCtx.createMediaStreamDestination();
  oscillator.connect(gain).connect(dest);
  oscillator.start();
  silentTrack = dest.stream.getAudioTracks()[0];
  return silentTrack;
}

export function setTalking(talking) {
  if (!localStream) return;
  for (const track of localStream.getAudioTracks()) track.enabled = talking;
}

export function destroyAudio() {
  initPromise = null;
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
  }
  if (silentTrack) {
    silentTrack.stop();
    silentTrack = null;
  }
  analyser = null;
  for (const entry of remoteAnalysers.values()) entry.source.disconnect();
  remoteAnalysers.clear();
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}
