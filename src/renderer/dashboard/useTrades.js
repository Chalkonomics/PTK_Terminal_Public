import { useCallback, useEffect, useRef, useState } from 'react';
import { dayStart } from './lib/calendar.js';

/**
 * Trades whose local day is in [fromDay, toDay) from the main process (which asks
 * Notion). Refetches when a trade's result lands in Notion, and on refresh().
 * @param {{ fromDay: string | null, toDay: string | null }} days  null = unbounded
 */
export function useTrades({ fromDay, toDay }) {
  const [state, setState] = useState({ trades: [], loading: true, error: null, updatedAt: null });
  const request = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const id = ++request.current;
      setState((s) => ({ ...s, loading: true }));
      let result;
      try {
        result = await window.dashboard.getTrades({ from: fromDay && dayStart(fromDay), to: toDay && dayStart(toDay), refresh });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      if (id !== request.current) return; // a newer range was asked for meanwhile
      setState((s) =>
        result.ok
          ? { trades: result.trades, loading: false, error: null, updatedAt: new Date() }
          : { ...s, loading: false, error: result.error ?? 'Could not read trades' },
      );
    },
    [fromDay, toDay],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => window.dashboard.onTradesChanged(() => load()), [load]);

  return { ...state, refresh: () => load(true) };
}
