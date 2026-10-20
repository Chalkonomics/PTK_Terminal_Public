import nodeFs from 'node:fs';
import path from 'node:path';

// Persistent activity log: every order sent, exchange response, outcome, remediation
// step and panic, so a bad trade can be reconstructed after the terminal is closed.
// One file per day (local date), appended synchronously so a crash can't lose lines.
// Logging must never break trading: failures fall back to the console only.

export const RETENTION_DAYS = 30;
const FILE_PATTERN = /^ptk-(\d{4}-\d{2}-\d{2})\.log$/;
// Anything shaped like a private key is scrubbed before it reaches disk. Transaction
// hashes have the same shape and are scrubbed too; that's the price of never leaking a key.
const SECRET_PATTERN = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

export function redact(text) {
  return String(text).replace(SECRET_PATTERN, '[redacted]');
}

/** Local calendar date as YYYY-MM-DD, so files roll over at the trader's midnight. */
export function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {object} opts
 * @param {string} opts.dir                   folder for the daily files
 * @param {() => number} [opts.now]
 * @param {typeof nodeFs} [opts.fs]
 * @param {(line: string) => void} [opts.echo]  console mirror
 */
export function createActivityLog({ dir, now = Date.now, fs = nodeFs, echo = console.log }) {
  let writable = true;

  try {
    fs.mkdirSync(dir, { recursive: true });
    prune();
  } catch (err) {
    writable = false;
    echo(`[log] cannot use ${dir}: ${err.message}; logging to console only`);
  }

  function fileFor(ms) {
    return path.join(dir, `ptk-${localDate(ms)}.log`);
  }

  /** Deletes daily files older than the retention window. */
  function prune() {
    const cutoff = localDate(now() - RETENTION_DAYS * 86_400_000);
    for (const name of fs.readdirSync(dir)) {
      const m = FILE_PATTERN.exec(name);
      if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, name));
    }
  }

  function log(line) {
    const clean = redact(line);
    echo(clean);
    if (!writable) return;
    const ms = now();
    try {
      fs.appendFileSync(fileFor(ms), `${new Date(ms).toISOString()} ${clean}\n`);
    } catch {
      // Disk full, folder deleted, file locked: keep trading, keep echoing.
    }
  }

  return {
    log,
    get file() {
      return fileFor(now());
    },
    dir,
  };
}
