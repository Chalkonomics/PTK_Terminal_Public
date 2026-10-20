// Audio feedback. The trader's eyes are on the chart at the moment of pressing,
// so each outcome has a distinct sound. A configured file from effects/ is played
// if set; otherwise (or if it fails to load) a synthesised placeholder.

const cache = new Map();
let ctx = null;

/** @param {{ kind: 'accepted' | 'refused' | 'danger', file: string | null }} sound */
export function playSound({ kind, file }) {
  if (!file) return beep(kind);
  let audio = cache.get(file);
  if (!audio) {
    audio = new Audio(`./${file}`);
    cache.set(file, audio);
  }
  audio.currentTime = 0;
  audio.play().catch(() => beep(kind));
}

// Placeholders: rising chirp = accepted, two low blips = refused, harsh alarm = danger.
const PATTERNS = {
  accepted: [[660, 0, 0.08], [990, 0.09, 0.12]],
  refused: [[220, 0, 0.09], [220, 0.14, 0.09]],
  danger: [0, 1, 2, 3, 4, 5].map((i) => [i % 2 ? 440 : 880, i * 0.16, 0.14]),
};

function beep(kind) {
  ctx ??= new AudioContext();
  const start = ctx.currentTime + 0.01;
  for (const [freq, offset, duration] of PATTERNS[kind] ?? PATTERNS.refused) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === 'danger' ? 'sawtooth' : 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, start + offset + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + offset);
    osc.stop(start + offset + duration);
  }
}
