// SVG loading/extraction, mouth-path geometry, and color theme

export const DPR = window.devicePixelRatio || 1;

// --- SVG asset loading ---

let earSVG = '';
let mouthSVG = '';
let figureSVG = '';

export async function loadSVGs() {
  const [ear, mouth, figure] = await Promise.all([
    fetch('ear.svg').then(r => r.text()),
    fetch('mouth.svg').then(r => r.text()),
    fetch('figure.svg').then(r => r.text()),
  ]);
  earSVG = ear;
  mouthSVG = mouth;
  figureSVG = figure;
}

export const getEarSVG = () => earSVG;
export const getFigureSVG = () => figureSVG;

// Inner content of an <svg>, with feDisplacementMap scale multiplied by DPR
export function extractSVGContent(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  let content = match ? match[1] : svg;
  return content.replace(
    /(<feDisplacementMap[^>]*scale=")(\d+(?:\.\d+)?)(")/gi,
    (_, before, scale, after) => `${before}${parseFloat(scale) * DPR}${after}`
  );
}

// --- mouth geometry ---

// Mouth viewBox: tight bounds with room for the mouth opening downward by up to 40px
export const MOUTH_VB_WIDTH = 115;
export const MOUTH_VB_HEIGHT = 90;
export const FILTER_SCALE = 4 * DPR;

// openness: 0 = closed, 1 = wide open. Moves the 5 lower-lip points down, corners fixed.
export function generateMouthPaths(openness) {
  const move = 40 * openness;
  const p1y = 27 + move;
  const p3y = 49 + move;
  const p4y = 49 + move;
  const p6y = 28.5556 + move;
  const p7y = 32.3333 + move;

  const upperPath = `M46.0013 7C39.9237 7 12.6372 28.5556 12.6372 28.5556H48.9518L63.7046 32.3333L74.826 27L113.637 28.5556C113.637 28.5556 80.8306 7 76.4147 7C71.9988 7 68.3268 14.4751 63.7046 15.4444C59.0825 16.4138 52.0788 7 46.0013 7Z`;
  const lowerPath = `M74.826 ${p1y}L113.637 28.5556C113.637 28.5556 90.4146 ${p3y} 83.2237 ${p3y}H41.235C33.5181 ${p4y} 12.6372 28.5556 12.6372 28.5556L48.9518 ${p6y}L63.7046 ${p7y}L74.826 ${p1y}Z`;

  return { upperPath, lowerPath };
}

export const CLOSED_MOUTH = generateMouthPaths(0);

// --- hashing (shared by theme + peer placement) ---

export function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// --- color theme ---

let isDarkMode = false;

export function detectSystemDarkMode() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function setDarkMode(dark) {
  isDarkMode = dark;
}

function colorFromRoomCode(code) {
  const hue = hashCode(code) % 360;
  const lightness = isDarkMode ? 35 : 50;
  return `hsl(${hue}, 70%, ${lightness}%)`;
}

// Dark = black fill / white stroke, Light = white fill / black stroke
export function applyTheme(roomCode) {
  const color = colorFromRoomCode(roomCode);
  const root = document.documentElement.style;
  root.setProperty('--bg', color);
  root.setProperty('--stroke-accent', color);
  root.setProperty('--fill', isDarkMode ? '#000000' : '#FFFFFF');
  root.setProperty('--stroke', isDarkMode ? '#FFFFFF' : '#000000');
}
