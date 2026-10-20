import nodeFs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, validateConfig } from './config.js';

// Session-level controls behind the ☰ menu: whether the mode can be switched right
// now, saving config changes safely, and remembering panel preferences.

export const MODES = ['dryRun', 'testnet', 'live'];

/**
 * Reasons a mode switch must wait. Switching restarts the app on a different
 * network, so anything in flight would be orphaned: the journal would read fills
 * from the wrong network and the panel would watch the wrong account.
 *
 * @param {object} s
 * @param {object | null} s.account        derived account (null when unknown)
 * @param {boolean} s.accountless          dry run without an accountAddress
 * @param {{ open: object | null } | null} s.journal
 * @param {boolean} s.busy                 a press or panic is running
 * @returns {string[]}
 */
export function switchBlockers({ account, accountless, journal, busy }) {
  const reasons = [];
  if (busy) reasons.push('a press or panic is running');
  if (!accountless && !account) reasons.push('account state not loaded yet');
  if (account?.position) reasons.push('a BTC position is open');
  if (account?.orders.length) reasons.push(`${account.orders.length} BTC order(s) resting`);
  if (journal?.open) reasons.push('the journal is still tracking a trade');
  return reasons;
}

/**
 * Applies `patch` to config.json after validating the result, writing to a
 * temporary file and renaming it into place so a crash can't leave it half-written.
 * Keys not in the patch are preserved exactly.
 */
export function saveConfigPatch(rootDir, patch, fs = nodeFs) {
  const file = path.join(rootDir, 'config.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = { ...current, ...patch };
  const errors = validateConfig({ ...DEFAULTS, ...next, sounds: { ...DEFAULTS.sounds, ...next.sounds } });
  if (errors.length) throw new Error(`refusing to save config.json: ${errors.join('; ')}`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return next;
}

const UI_DEFAULTS = Object.freeze({ alwaysOnTop: true, compact: false });

/** Panel preferences from ui-state.json; defaults if missing or unreadable. */
export function loadUiPrefs(rootDir, fs = nodeFs) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(rootDir, 'ui-state.json'), 'utf8'));
    return {
      alwaysOnTop: typeof saved.alwaysOnTop === 'boolean' ? saved.alwaysOnTop : UI_DEFAULTS.alwaysOnTop,
      compact: typeof saved.compact === 'boolean' ? saved.compact : UI_DEFAULTS.compact,
    };
  } catch {
    return { ...UI_DEFAULTS };
  }
}

export function saveUiPrefs(rootDir, prefs, fs = nodeFs) {
  try {
    fs.writeFileSync(path.join(rootDir, 'ui-state.json'), JSON.stringify(prefs, null, 2) + '\n');
  } catch {
    // Preferences are a convenience; never fail over them.
  }
}
