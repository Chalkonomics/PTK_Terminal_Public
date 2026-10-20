// Display formatting only. All numbers arrive pre-computed from the main process.

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const px1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const price = (n) => (n == null ? '—' : px1.format(n));
export const usd = (n) => (n == null ? '—' : usd2.format(n));
export const whole = (n) => (n == null ? '—' : usd0.format(n));
export const pct = (f, digits = 2) => (f == null ? '—' : `${(f * 100).toFixed(digits)}%`);
export const signed = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${usd2.format(Math.abs(n))}`);

export function age(ms) {
  if (ms == null) return 'unknown';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function ago(ms) {
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

export const MODE_LABELS = { dryRun: 'DRY RUN', testnet: 'TESTNET', live: 'LIVE' };
