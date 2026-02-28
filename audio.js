// Audio: getUserMedia, PTT track toggle, analyser, silent track

let localStream = null;
let audioCtx = null;
let analyser = null;
let silentTrack = null;
let initPromise = null;

export function initAudioContext() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
}

export function initAudio() {
  if (initPromise) return initPromise;
  initPromise = _initAudio().finally(() => { initPromise = null; });
  return initPromise;
}

async function _initAudio() {
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  for (const track of localStream.getAudioTracks()) {
    track.enabled = false;
  }
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.5;
  const source = audioCtx.createMediaStreamSource(localStream);
  source.connect(analyser);
}

export function getStream() {
  return localStream;
}

export function getRealTrack() {
  return localStream ? localStream.getAudioTracks()[0] : null;
}

export function getAnalyser() {
  return analyser;
}

const remoteAnalysers = new Map();

export function createRemoteAnalyser(peerId, stream) {
  removeRemoteAnalyser(peerId);
  if (!audioCtx) return null;
  const source = audioCtx.createMediaStreamSource(stream);
  const an = audioCtx.createAnalyser();
  an.fftSize = 128;
  an.smoothingTimeConstant = 0.5;
  source.connect(an);
  remoteAnalysers.set(peerId, { source, analyser: an });
  return an;
}

export function getRemoteAnalyser(peerId) {
  const entry = remoteAnalysers.get(peerId);
  return entry ? entry.analyser : null;
}

export function removeRemoteAnalyser(peerId) {
  const entry = remoteAnalysers.get(peerId);
  if (entry) {
    entry.source.disconnect();
    remoteAnalysers.delete(peerId);
  }
}

export function getSilentTrack() {
  if (silentTrack) return silentTrack;
  if (!audioCtx) return null;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  const dest = audioCtx.createMediaStreamDestination();
  gain.connect(dest);
  oscillator.start();
  silentTrack = dest.stream.getAudioTracks()[0];
  return silentTrack;
}

export function setTalking(talking) {
  if (!localStream) return;
  for (const track of localStream.getAudioTracks()) {
    track.enabled = talking;
  }
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
