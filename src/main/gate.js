import { computePlan, MIN_ORDER_NOTIONAL } from './sizing.js';
import { leverageMismatch } from './account.js';

// The validation gate. One pure function drives both the panel's ready light
// (continuously, with direction inferred from stop vs mark) and the hotkey press
// (with the pressed direction). If they could disagree, the panel would be lying.
//
// Checks run in order and the first failure stops evaluation. The order plan is
// computed regardless, so the panel can show the size next to the refusal reason.

const MARGIN_WARN_USAGE = 0.5;

/**
 * Kill switch for live submission. Enabled once stop-failure remediation (retry,
 * auto-flatten) was proven on testnet; set false to force-refuse every live press.
 */
export const LIVE_ENABLED = true;

export const CHECKS = [
  ['execution', 'Orders enabled'],
  ['connection', 'Feed connected'],
  ['leverage', 'Leverage verified'],
  ['noPosition', 'No open position'],
  ['noOrders', 'No resting BTC orders'],
  ['clipboardParses', 'Stop price parses'],
  ['clipboardFresh', 'Stop price is fresh'],
  ['magnitude', 'Stop near mark'],
  ['side', 'Stop on correct side'],
  ['distance', 'Stop distance in band'],
  ['size', 'Size valid'],
  ['margin', 'Margin available'],
  ['liquidation', 'Liquidation beyond stop'],
];

/**
 * @param {object} input
 * @param {object} input.config
 * @param {object} input.market     market.snapshot()
 * @param {object} input.clipboard  watcher.snapshot()
 * @param {'long' | 'short' | null} [input.direction]  null/omitted infers from stop vs mark
 * @param {{ ready: boolean, error: string | null } | null} [input.execution]  order executor status; null in dry run
 * @param {boolean} [input.liveArmed]  live trading confirmed for this session
 * @returns {GateResult}
 */
export function validate({ config, market, clipboard, direction = null, execution = null, liveArmed = false }) {
  const { spec, mark, account } = market;
  const stop = clipboard.value;

  const inferred = mark > 0 && stop > 0 && stop !== mark ? (stop < mark ? 'long' : 'short') : null;
  const dir = direction ?? inferred;

  // Dry run without an account address can't see positions, orders or free collateral.
  const accountless = config.mode === 'dryRun' && !config.accountAddress;
  const equity = config.equitySource === 'fixed' ? config.equityFixed : account?.equity ?? null;
  const freeCollateral = accountless ? equity : dir ? account?.availableToTrade[dir === 'long' ? 'buy' : 'sell'] ?? null : null;

  const plan = dir ? computePlan({ direction: dir, mark, stop, equity, config, spec, takerFeeRate: market.takerFeeRate ?? undefined }) : null;
  const marginUsage = plan && freeCollateral > 0 ? plan.margin / freeCollateral : null;

  const warnings = [];
  if (accountless) warnings.push('No accountAddress: position, order and leverage checks skipped');

  const rules = {
    execution() {
      if (config.mode === 'dryRun') return SKIP;
      if (config.mode === 'live' && !LIVE_ENABLED) return fail('live trading is disabled (LIVE_ENABLED kill switch)');
      if (!execution) return fail('order executor missing');
      if (!execution.ready) return fail(execution.error ?? 'order executor not ready');
      // LIVE starts disarmed every session so the app is never trading real money by surprise.
      if (config.mode === 'live' && !liveArmed) return fail(LIVE_DISARMED);
    },
    connection() {
      if (market.status !== 'ready' || !market.wsOpen) return fail(market.error ?? `feed ${market.wsOpen ? market.status : 'disconnected'}`);
      if (!spec) return fail('market metadata not loaded');
      if (mark === null || market.markAgeMs === null) return fail('no mark price received');
      if (market.markAgeMs > config.markMaxAgeMs) return fail(`mark is ${secs(market.markAgeMs)} old (max ${secs(config.markMaxAgeMs)})`);
      if (!accountless && !account) return fail('account data not loaded');
      if (!(equity > 0)) return fail(`equity is ${equity ?? 'unknown'}`);
    },
    leverage() {
      if (accountless) return SKIP;
      const mismatch = leverageMismatch(account, config.leverage);
      if (mismatch) return fail(mismatch);
    },
    noPosition() {
      if (accountless) return SKIP;
      const p = account.position;
      if (p) return fail(`${p.size > 0 ? 'long' : 'short'} ${Math.abs(p.size)} BTC open; flatten first`);
    },
    noOrders() {
      if (accountless) return SKIP;
      const n = account.orders.length;
      if (n) return fail(`${n} resting BTC order${n > 1 ? 's' : ''}; cancel first`);
    },
    clipboardParses() {
      if (stop === null) return fail(clipboard.raw ? `${JSON.stringify(clipboard.raw.slice(0, 24))}: ${clipboard.error}` : clipboard.error ?? 'clipboard empty');
    },
    clipboardFresh() {
      const age = clipboard.ageMs;
      if (age === null || !Number.isFinite(age)) return fail('copy time unknown (copied before launch); copy the stop again');
      if (age > config.clipboardMaxAgeMs) return fail(`copied ${secs(age)} ago (max ${secs(config.clipboardMaxAgeMs)}); copy the stop again`);
      if (age > config.clipboardWarnAgeMs) warnings.push(`Stop copied ${secs(age)} ago`);
    },
    magnitude() {
      const off = Math.abs(stop - mark) / mark;
      if (off > config.magnitudeBandPct) return fail(`stop ${num(stop)} is ${pct(off)} from mark ${num(mark)} (max ${pct(config.magnitudeBandPct)}); wrong instrument or mis-parse?`);
    },
    side() {
      if (stop === mark) return fail('stop equals mark');
      if (direction && direction !== inferred) {
        return fail(`${direction.toUpperCase()} pressed but stop ${num(stop)} is ${stop < mark ? 'below' : 'above'} mark ${num(mark)}; wrong key or wrong level`);
      }
    },
    distance() {
      if (!plan) return fail('could not compute stop distance');
      const { stopDistance: d, stopDistancePct: p } = plan;
      if (d < config.minStopDistance) return fail(`stop ${num(d)} USD away (min ${num(config.minStopDistance)})`);
      if (p < config.minStopDistancePct) return fail(`stop ${pct(p)} away (min ${pct(config.minStopDistancePct)})`);
      if (p > config.maxStopDistancePct) return fail(`stop ${pct(p)} away (max ${pct(config.maxStopDistancePct)})`);
    },
    size() {
      if (!(plan.size > 0)) return fail(`size ${plan.intendedSize.toFixed(8)} BTC rounds to zero`);
      if (plan.notional < MIN_ORDER_NOTIONAL) return fail(`notional ${num(plan.notional)} USD below exchange minimum ${MIN_ORDER_NOTIONAL}`);
    },
    margin() {
      if (!(freeCollateral > 0)) return fail('no free collateral');
      if (marginUsage > config.maxMarginUsage) {
        return fail(`needs ${num(plan.margin)} USDC margin, ${pct(marginUsage)} of ${num(freeCollateral)} free (max ${pct(config.maxMarginUsage)})`);
      }
      if (marginUsage > MARGIN_WARN_USAGE) warnings.push(`Margin ${pct(marginUsage)} of free collateral`);
    },
    liquidation() {
      const needed = plan.stopDistanceFromWorstEntry * config.minLiqToStopRatio;
      if (plan.liqDistance < needed) {
        return fail(`liquidation ~${num(plan.liqPx)} is ${num(plan.liqDistance)} from entry; stop is ${num(plan.stopDistanceFromWorstEntry)} (need ${config.minLiqToStopRatio}× clearance)`);
      }
    },
  };

  const checks = [];
  let failed = null;
  for (const [id, label] of CHECKS) {
    if (failed) {
      checks.push({ id, label, status: 'notRun', detail: null });
      continue;
    }
    const result = rules[id]();
    if (result === SKIP) checks.push({ id, label, status: 'skip', detail: null });
    else if (result) {
      failed = { id, label, detail: result.detail };
      checks.push({ id, label, status: 'fail', detail: result.detail });
    } else checks.push({ id, label, status: 'pass', detail: null });
  }

  const ok = failed === null;
  return {
    ok,
    level: !ok ? 'red' : warnings.length ? 'amber' : 'green',
    direction: dir,
    inferredDirection: inferred,
    failed,
    warnings,
    checks,
    plan,
    marginUsage,
    freeCollateral,
  };
}

/**
 * Check 12: refuses if the mark has moved more than maxSlippageBps between
 * `reference.mark` (the keypress, or the plan when re-checked just before
 * submission) and `currentMark`. Returns a reason string or null.
 */
export function markMoved(plan, currentMark, maxSlippageBps) {
  if (!(currentMark > 0)) return 'no current mark';
  const movedBps = (Math.abs(currentMark - plan.mark) / plan.mark) * 10_000;
  if (movedBps > maxSlippageBps) return `mark moved ${movedBps.toFixed(1)}bp since the press (max ${maxSlippageBps}bp); press again`;
  return null;
}

export const LIVE_DISARMED = 'LIVE is not armed for this session: click Arm LIVE to enable trading';
const SKIP = Symbol('skip');
const fail = (detail) => ({ detail });
const secs = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const pct = (f) => `${(f * 100).toFixed(2)}%`;
const num = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * @typedef {object} GateResult
 * @property {boolean} ok
 * @property {'green' | 'amber' | 'red'} level
 * @property {'long' | 'short' | null} direction
 * @property {'long' | 'short' | null} inferredDirection
 * @property {{ id: string, label: string, detail: string } | null} failed
 * @property {string[]} warnings
 * @property {{ id: string, label: string, status: 'pass' | 'fail' | 'skip' | 'notRun', detail: string | null }[]} checks
 * @property {object | null} plan
 * @property {number | null} marginUsage
 * @property {number | null} freeCollateral
 */
