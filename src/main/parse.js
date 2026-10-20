// Strict parser for stop prices copied from the Hyperliquid chart, e.g. "83,298".
// Commas are always thousands separators: the source format is known, so no
// locale-aware decimal handling. The gate's magnitude check is the backstop.

const MAX_LENGTH = 24;
const ALLOWED_CHARS = /^[0-9,. ]+$/;

/**
 * @param {unknown} raw
 * @returns {{ value: number | null, error: string | null }}
 */
export function parseStopPrice(raw) {
  if (typeof raw !== 'string') return fail('clipboard is not text');

  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('clipboard is empty');
  if (trimmed.length > MAX_LENGTH) return fail('too long to be a price');
  if (!ALLOWED_CHARS.test(trimmed)) return fail('contains non-price characters');

  const stripped = trimmed.replace(/[ ,]/g, '');
  if ((stripped.match(/\./g) ?? []).length > 1) return fail('more than one decimal point');

  const value = Number(stripped);
  if (!Number.isFinite(value)) return fail('not a number');
  if (value <= 0) return fail('zero or negative');

  return { value, error: null };
}

function fail(error) {
  return { value: null, error };
}
