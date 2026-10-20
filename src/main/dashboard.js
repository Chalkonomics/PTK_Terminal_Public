// Main-process side of the trades dashboard. The window asks for a date range;
// the Notion token never leaves this process.

const MAX_CACHED_RANGES = 50;

/** An ISO instant, or null for an open end; anything else is rejected. */
function rangeEnd(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('bad date range');
  return new Date(value).toISOString();
}

/**
 * Caches trades per range until a trade's result lands in Notion (invalidate()).
 * Concurrent requests for the same range share one Notion query.
 * @param {{ query: (range: { from: string | null, to: string | null }) => Promise<object[]> }} deps
 */
export function createTradesReader({ query }) {
  const cache = new Map();

  return {
    async read(range = {}) {
      const from = rangeEnd(range.from);
      const to = rangeEnd(range.to);
      const key = `${from}|${to}`;
      if (range.refresh === true) cache.delete(key);
      if (!cache.has(key)) {
        if (cache.size >= MAX_CACHED_RANGES) cache.delete(cache.keys().next().value);
        const pending = query({ from, to });
        cache.set(key, pending);
        // A failed read isn't cached, so Refresh tries Notion again.
        pending.catch(() => cache.get(key) === pending && cache.delete(key));
      }
      return cache.get(key);
    },
    invalidate() {
      cache.clear();
    },
  };
}

/** Only Notion pages may be opened from the dashboard. */
export function isNotionUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && ['notion.so', 'notion.com', 'notion.site'].some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
