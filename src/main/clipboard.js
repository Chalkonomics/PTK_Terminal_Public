import { parseStopPrice } from './parse.js';

// Polls the clipboard and timestamps each change, since the clipboard carries
// no timestamp of its own. Content already present at startup has an unknown
// capture time, so it is treated as infinitely stale and cannot be fired.

/**
 * @param {object} opts
 * @param {() => string | Promise<string>} opts.readText   e.g. Electron's clipboard.readText (async since Electron 44)
 * @param {number} opts.pollMs
 * @param {() => number} [opts.now]
 * @param {(snapshot: ClipboardSnapshot) => void} [opts.onChange]
 */
export function createClipboardWatcher({ readText, pollMs, now = Date.now, onChange }) {
  let raw = null;
  let parsed = { value: null, error: 'no clipboard read yet' };
  let capturedAt = null;
  let primed = false;
  let timer = null;
  let reading = false;

  async function tick() {
    if (reading) return;
    reading = true;
    let text;
    try {
      text = await readText();
    } catch {
      // Windows briefly locks the clipboard while another process writes; skip this tick.
      return;
    } finally {
      reading = false;
    }
    if (typeof text !== 'string') text = '';
    if (primed && text === raw) return;

    raw = text;
    parsed = parseStopPrice(text);
    capturedAt = primed ? now() : null;
    primed = true;
    onChange?.(snapshot());
  }

  /** @returns {ClipboardSnapshot} */
  function snapshot() {
    return {
      raw,
      value: parsed.value,
      error: parsed.error,
      capturedAt,
      ageMs: capturedAt === null ? Infinity : now() - capturedAt,
    };
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, pollMs);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick,
    snapshot,
  };
}

/**
 * @typedef {object} ClipboardSnapshot
 * @property {string | null} raw
 * @property {number | null} value
 * @property {string | null} error
 * @property {number | null} capturedAt  null when the capture time is unknown
 * @property {number} ageMs              Infinity when the capture time is unknown
 */
