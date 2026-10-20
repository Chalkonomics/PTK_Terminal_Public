import { LIVE_ENABLED, markMoved } from './gate.js';
import { assessOutcome, buildOrderAction, newCloid } from './orders.js';
import { createProtector } from './protect.js';

// What happens when a hotkey is pressed. Each press takes a lock that is held
// until the whole sequence resolves, followed by a short cooldown: Windows
// auto-repeats a held hotkey, so without the cooldown a held key would fire
// again the moment the first press finished.
//
// Panic is not subject to the lock. It takes over from any press in progress:
// the press sees the abort flag and stops before its next remediation step.

export const PRESS_COOLDOWN_MS = 1500;
/** Wait before re-reading the account when the first read-back is inconclusive. */
export const RECHECK_MS = 600;
/** Outcomes where the entry (may have) filled, so the trade belongs in the journal. */
const ENTRY_FILLED_OUTCOMES = new Set(['protected', 'protectedOnRetry', 'closedImmediately', 'flattened', 'flattenFailed']);

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {object} deps.market            createMarket() result
 * @param {(kind: 'accepted' | 'refused' | 'danger') => void} deps.playSound
 * @param {object} [deps.executor]        createExecutor() result; null in dry run
 * @param {object} [deps.journal]         createJournal() result
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createActions({ config, store, market, playSound, executor = null, journal = null, log = console.log, now = Date.now, sleep = defaultSleep }) {
  let locked = false;
  let cooldownUntil = 0;
  let panicking = false;

  const protector = executor ? createProtector({ executor, market, sleep, log, isAborted: () => panicking }) : null;

  function refuse(text) {
    store.setLastAction('refused', text);
    playSound('refused');
    log(`[press] ${text}`);
  }

  function alarm(text) {
    store.setLastAction('error', text);
    playSound('danger');
    log(`[press] !!! ${text}`);
  }

  async function readAccount() {
    try {
      return await market.refreshAccount();
    } catch {
      return null;
    }
  }

  async function press(direction) {
    const label = direction.toUpperCase();
    if (panicking) {
      store.setLastAction('info', `${label} press ignored: panic in progress`);
      return;
    }
    if (locked || now() < cooldownUntil) {
      store.setLastAction('info', `${label} press ignored: previous press still ${locked ? 'running' : 'settling'}`);
      return;
    }
    locked = true;
    store.setBusy(true);
    // The mark when the trader decided. Size is computed from the current mark after
    // the refresh, but if price has run more than maxSlippageBps since the keypress,
    // the setup the trader saw is gone.
    const markAtPress = market.snapshot().mark;
    try {
      // Checks 2, 3 and 10 must run on the exchange's current state, not the WebSocket cache.
      if (config.accountAddress) {
        try {
          await market.refreshAccount();
        } catch (err) {
          refuse(`Refused ${label}: could not refresh account (${err.message})`);
          return;
        }
      }

      const gate = store.gate(direction);
      if (!gate.ok) {
        refuse(`Refused ${label}: ${gate.failed.label}: ${gate.failed.detail}`);
        return;
      }

      // Check 12: the mark may have moved while the account refresh was in flight.
      const moved = markMoved({ mark: markAtPress }, gate.plan.mark, config.maxSlippageBps);
      if (moved) {
        refuse(`Refused ${label}: ${moved}`);
        return;
      }

      const p = gate.plan;
      const spec = market.snapshot().spec;
      const clipboardAgeMs = store.clipboardSnapshot().ageMs;

      if (config.mode === 'dryRun') {
        const action = buildOrderAction(p, spec, { entryCloid: '0x(entry)', stopCloid: '0x(stop)' });
        store.setLastAction('accepted', `DRY RUN ${label} ${p.sizeStr} BTC, stop ${p.stopPxStr}, risk ${p.riskUsd.toFixed(2)} USD [${store.setupLabel}] (not sent)`);
        playSound('accepted');
        log(`[press] DRY RUN would send: ${JSON.stringify({ action, markAtPress, riskUsd: round(p.riskUsd, 4), notional: round(p.notional, 2), margin: round(p.margin, 2) })}`);
        journal?.recordDryRun({ tradeId: newCloid(), ts: now(), plan: p, markAtPress, clipboardAgeMs, setupLabel: store.setupLabel });
        return;
      }

      // The gate already covers these; checked again here as defence in depth.
      if (config.mode === 'live' && !LIVE_ENABLED) {
        refuse(`Refused ${label}: live trading is disabled`);
        return;
      }
      if (!executor?.status.ready || !protector) {
        refuse(`Refused ${label}: order executor not ready (${executor?.status.error ?? 'missing'})`);
        return;
      }

      // Check 12 again, immediately before sending.
      const lastMove = markMoved(p, market.snapshot().mark, config.maxSlippageBps);
      if (lastMove) {
        refuse(`Refused ${label}: ${lastMove}`);
        return;
      }

      const cloids = { entryCloid: newCloid(), stopCloid: newCloid() };
      const action = buildOrderAction(p, spec, cloids);
      const sentAt = now();
      log(`[order] sending ${JSON.stringify(action)}`);
      const submission = await executor.submit(action);
      log(`[order] response after ${now() - sentAt}ms: ${JSON.stringify(submission)}`);

      // The exchange's state decides the outcome, not the response. Re-check once if inconclusive.
      let outcome = assessOutcome(submission, await readAccount(), p);
      if (outcome.kind === 'unknown') {
        await sleep(RECHECK_MS);
        outcome = assessOutcome(submission, await readAccount(), p);
      }
      log(`[order] outcome: ${JSON.stringify({ ...outcome, tradeId: cloids.entryCloid })}`);

      // Anything short of "protected" or "nothing happened" is fixed here: retry the stop, else flatten.
      const final = await protector.ensureProtected(p, outcome);
      if (final !== outcome) log(`[order] remediation: ${JSON.stringify(final)}`);
      if (ENTRY_FILLED_OUTCOMES.has(final.kind)) {
        journal?.openTrade({
          tradeId: cloids.entryCloid,
          tsEntry: sentAt,
          plan: p,
          markAtPress,
          clipboardAgeMs,
          setupLabel: store.setupLabel,
          outcome: final.kind,
          stopOid: final.position?.stop?.oid ?? null,
        });
      }
      report({ final, submission, plan: p, label, markAtPress });
    } finally {
      locked = false;
      cooldownUntil = now() + PRESS_COOLDOWN_MS;
      store.setBusy(false);
    }
  }

  function report({ final, submission, plan, label, markAtPress }) {
    const tag = `[${store.setupLabel}]`;
    switch (final.kind) {
      case 'protected':
      case 'protectedOnRetry': {
        const pos = final.position;
        const fill = submission.kind === 'responded' && submission.entry.filled ? submission.entry : null;
        const entryPx = fill?.avgPx ?? pos.entryPx;
        const side = plan.direction === 'long' ? 1 : -1;
        const slipBps = ((side * (entryPx - markAtPress)) / markAtPress) * 10_000;
        const partial = Math.abs(pos.size) < plan.size - 1e-9 ? ` (partial: ${Math.abs(pos.size)} of ${plan.sizeStr})` : '';
        const retried = final.kind === 'protectedOnRetry' ? ` (attached on RETRY; first attempt: ${final.reason})` : '';
        const text = `FILLED ${label} ${Math.abs(pos.size)} BTC @ ${entryPx} (slip ${slipBps >= 0 ? '+' : ''}${slipBps.toFixed(1)}bp)${partial}, stop ${pos.stop.triggerPx} on exchange${retried} ${tag}`;
        store.setLastAction(final.kind === 'protected' ? 'accepted' : 'refused', text);
        playSound('accepted');
        log(`[press] ${text}`);
        return;
      }
      case 'notFilled':
        refuse(`${label} not filled: ${String(final.reason).replace(/\.$/, '')}. Nothing open.`);
        return;
      case 'closedImmediately':
        store.setLastAction('refused', `${label} FILLED ${final.fill.totalSz} BTC @ ${final.fill.avgPx} but the position is already closed (stop hit immediately, or closed elsewhere). Flat now; check the fill in the Hyperliquid UI.`);
        playSound('refused');
        log(`[press] ${label} filled then closed immediately: ${JSON.stringify(final.fill)}`);
        return;
      case 'flattened':
        alarm(`${label} FLATTENED: entry filled but the stop could not be attached (${final.reason}). Position closed at market; you are flat.`);
        return;
      case 'flattenFailed':
        alarm(`${label}: COULD NOT CONFIRM FLAT (${final.reason}). Close the BTC position in the Hyperliquid UI NOW.`);
        return;
      case 'aborted':
        log(`[press] ${label} sequence stopped: panic took over`);
        return;
      default:
        alarm(`STATE UNCLEAR after ${label}: ${final.reason ?? final.kind}. Check the Hyperliquid UI now.`);
    }
  }

  async function panic() {
    // Runs regardless of validation state, needs no clipboard value, and ignores the press lock.
    if (config.mode === 'dryRun') {
      const account = market.snapshot().account;
      const position = account?.position;
      const orders = account?.orders.length ?? 0;
      const what = [position && `close ${position.size > 0 ? 'long' : 'short'} ${Math.abs(position.size)} BTC`, orders && `cancel ${orders} BTC order${orders > 1 ? 's' : ''}`]
        .filter(Boolean)
        .join(' and ');
      store.setLastAction('info', `DRY RUN panic: ${what || 'nothing to do (flat, no orders)'}`);
      log(`[panic] DRY RUN: ${what || 'nothing to do'}`);
      return;
    }
    if (panicking) return;
    if (!executor?.status.ready || !protector) {
      alarm(`PANIC FAILED: order executor not ready (${executor?.status.error ?? 'missing'}). Flatten in the Hyperliquid UI.`);
      return;
    }

    panicking = true;
    store.setBusy(true);
    journal?.markPanic();
    log('[panic] cancelling all BTC orders and flattening');
    try {
      const before = await protector.readAccount();
      const cancelled = await protector.cancelAll(before);
      const result = await protector.flatten(['panic']);
      if (result.flat) {
        const did = [before?.position && `closed ${before.position.size > 0 ? 'long' : 'short'} ${Math.abs(before.position.size)} BTC`, cancelled.cancelled && `cancelled ${cancelled.cancelled} order(s)`]
          .filter(Boolean)
          .join(', ');
        store.setLastAction('info', `PANIC done: ${did || 'already flat, no orders'}. Flat confirmed.`);
        playSound('refused');
        log(`[panic] done: ${did || 'nothing to do'}`);
      } else {
        alarm(`PANIC: could not confirm flat after ${result.steps.length} step(s). Close the BTC position in the Hyperliquid UI NOW.`);
      }
    } finally {
      panicking = false;
      cooldownUntil = now() + PRESS_COOLDOWN_MS;
      store.setBusy(false);
    }
  }

  return {
    long: () => press('long'),
    short: () => press('short'),
    panic,
  };
}

const round = (n, dp) => Number(n.toFixed(dp));
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
