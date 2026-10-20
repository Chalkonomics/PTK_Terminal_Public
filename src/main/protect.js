import { roundPrice } from './sizing.js';

// Failure remediation. An unstopped position is never left open, under any
// circumstance: a missing stop gets one retry, then the position is flattened
// with progressively wider price limits until the exchange confirms it's flat.
// The entry is never re-sent. Every decision is made from a fresh read of the
// exchange, not from what an earlier response claimed.

/** Price limits for flatten attempts, in bps through the mark. Widens until it fills. */
export const FLATTEN_SLIPPAGE_BPS = [50, 200, 500];
export const RECONCILE_READS = 3;
export const SETTLE_MS = 400;

/**
 * @param {object} deps
 * @param {object} deps.executor   createExecutor() result
 * @param {object} deps.market     createMarket() result
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {(line: string) => void} [deps.log]
 * @param {() => boolean} [deps.isAborted]  true once panic has taken over
 */
export function createProtector({ executor, market, sleep, log = console.log, isAborted = () => false }) {
  async function readAccount() {
    try {
      return await market.refreshAccount();
    } catch {
      return null;
    }
  }

  async function readWithRetries() {
    for (let i = 0; i < RECONCILE_READS; i++) {
      const account = await readAccount();
      if (account) return account;
      await sleep(SETTLE_MS);
    }
    return null;
  }

  const spec = () => market.snapshot().spec;
  const sizeStr = (size) => Math.abs(size).toFixed(spec().szDecimals);

  /** Cancels every resting BTC order. Only called when flat or flattening. */
  async function cancelAll(account) {
    const oids = (account?.orders ?? []).map((o) => o.oid);
    if (!oids.length) return { cancelled: 0 };
    const r = await executor.cancel({ assetId: spec().assetId, oids });
    log(`[protect] cancel ${oids.length} BTC order(s): ${r.ok ? 'ok' : r.error}`);
    return { cancelled: r.ok ? oids.length : 0, error: r.ok ? null : r.error };
  }

  /**
   * Closes any open BTC position with reduce-only IOC orders at widening limits,
   * then cancels leftover orders. Returns once flat or out of attempts.
   */
  async function flatten(steps = []) {
    for (const bps of FLATTEN_SLIPPAGE_BPS) {
      const account = await readAccount();
      if (!account) {
        steps.push('could not read account');
        await sleep(SETTLE_MS);
        continue;
      }
      if (!account.position) {
        await cancelAll(account);
        steps.push('flat');
        return { flat: true, steps };
      }
      const pos = account.position;
      const isLong = pos.size > 0;
      const mark = market.snapshot().mark ?? pos.entryPx;
      const limit = roundPrice(mark * (1 - ((isLong ? 1 : -1) * bps) / 10_000), spec(), isLong ? 'down' : 'up');
      const r = await executor.closePosition({ assetId: spec().assetId, isLong, sizeStr: sizeStr(pos.size), limitPxStr: limit.str });
      steps.push(`close ${sizeStr(pos.size)} @ ${limit.str} (${bps}bp): ${r.ok ? 'sent' : r.error}`);
      log(`[protect] ${steps.at(-1)}`);
      await sleep(SETTLE_MS);
    }
    const final = await readAccount();
    if (final && !final.position) {
      await cancelAll(final);
      return { flat: true, steps };
    }
    return { flat: false, steps, position: final?.position ?? null };
  }

  /** One attempt to attach a full-size stop to the open position at the planned level. */
  async function retryStop(plan, position) {
    const r = await executor.placeStop({
      assetId: spec().assetId,
      isLong: position.size > 0,
      sizeStr: sizeStr(position.size),
      triggerPxStr: plan.stopPxStr,
      limitPxStr: plan.stopLimitPxStr,
    });
    const stopError = r.statuses?.find((st) => st?.error)?.error ?? (r.ok ? null : r.error);
    log(`[protect] retry stop: ${stopError ?? 'accepted'}`);
    await sleep(SETTLE_MS / 2);
    const account = await readAccount();
    return { ok: Boolean(account?.position?.stop?.coversSize), error: stopError, account };
  }

  /**
   * Takes the post-submission outcome and makes sure it ends either protected or
   * flat. Returns the final state for reporting.
   *
   * @returns {Promise<{ kind: 'protected' | 'protectedOnRetry' | 'notFilled' | 'closedImmediately' | 'flattened' | 'flattenFailed' | 'aborted', reason?: string, position?: object, fill?: object, steps?: string[] }>}
   */
  async function ensureProtected(plan, outcome) {
    if (outcome.kind === 'protected') return outcome;

    if (outcome.kind === 'notFilled') {
      if (outcome.leftoverOrders) await cancelAll(await readAccount());
      return outcome;
    }

    let account = null;
    let position = outcome.position ?? null;
    let why = outcome.reason;

    if (outcome.kind === 'unknown') {
      // Reconcile: never re-send the entry; find out what actually exists.
      account = await readWithRetries();
      if (!account) {
        // Can't see the exchange. A reduce-only close of the planned size is safe
        // whether or not the position exists, so send it blind.
        if (isAborted()) return { kind: 'aborted' };
        const isLong = plan.direction === 'long';
        const limit = roundPrice(plan.mark * (1 - ((isLong ? 1 : -1) * FLATTEN_SLIPPAGE_BPS[1]) / 10_000), spec(), isLong ? 'down' : 'up');
        const r = await executor.closePosition({ assetId: spec().assetId, isLong, sizeStr: plan.sizeStr, limitPxStr: limit.str });
        return { kind: 'flattenFailed', reason: `cannot read the exchange; blind reduce-only close ${r.ok ? 'sent' : `failed (${r.error})`}`, steps: [] };
      }
      position = account.position;
      if (!position) {
        await cancelAll(account);
        // The exchange said it filled, so this was a real trade that is already over
        // (stop hit straight away, or closed elsewhere), not a missed entry.
        if (outcome.fill) return { kind: 'closedImmediately', fill: outcome.fill };
        return { kind: 'notFilled', reason: `no position after reconciling (${why})` };
      }
      const direction = position.size > 0 ? 'long' : 'short';
      if (direction === plan.direction && position.stop?.coversSize) return { kind: 'protected', position };
      if (direction !== plan.direction) {
        // Never expected; refuse to guess. Get flat.
        if (isAborted()) return { kind: 'aborted' };
        const f = await flatten([`unexpected ${direction} position`]);
        return f.flat
          ? { kind: 'flattened', reason: `unexpected ${direction} position after a ${plan.direction} press`, steps: f.steps }
          : { kind: 'flattenFailed', reason: `unexpected ${direction} position and flatten did not complete`, position: f.position, steps: f.steps };
      }
      why = position.stop ? 'stop covers only part of the position' : 'no stop on the exchange';
    }

    // Unprotected: one stop retry, then flatten.
    if (isAborted()) return { kind: 'aborted' };
    const retry = await retryStop(plan, position);
    if (retry.ok) return { kind: 'protectedOnRetry', reason: why, position: retry.account.position };

    if (isAborted()) return { kind: 'aborted' };
    const f = await flatten([`stop retry failed: ${retry.error ?? 'still unprotected'}`]);
    if (f.flat) return { kind: 'flattened', reason: `${why}; stop retry failed (${retry.error ?? 'still unprotected'})`, steps: f.steps };
    return { kind: 'flattenFailed', reason: `${why}; stop retry failed and flatten did not complete`, position: f.position, steps: f.steps };
  }

  return { ensureProtected, flatten, cancelAll, readAccount };
}
