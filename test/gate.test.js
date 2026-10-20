import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, markMoved, validate } from '../src/main/gate.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const ADDRESS = '0x' + 'a'.repeat(40);
const CONFIG = { ...DEFAULTS, accountAddress: ADDRESS, equitySource: 'fixed', equityFixed: 1000 };

const account = (over = {}) => ({
  equity: 908, equityBasis: 'unified (spot USDC)', position: null, orders: [],
  leverage: { type: 'isolated', value: 20 }, availableToTrade: { buy: 908, sell: 908 }, ...over,
});
const market = (over = {}) => ({
  network: 'mainnet', status: 'ready', error: null, wsOpen: true, spec: SPEC,
  mark: 83_520, markAgeMs: 300, account: account(), accountAgeMs: 100, ...over,
});
const clip = (value, ageMs = 5_000, extra = {}) => ({ raw: String(value), value, error: null, capturedAt: 0, ageMs, ...extra });

function run({ config = {}, mkt = {}, clipboard = clip(83_298), direction = 'long', execution = { ready: true, error: null }, liveArmed = true } = {}) {
  return validate({ config: { ...CONFIG, ...config }, market: market(mkt), clipboard, direction, execution, liveArmed });
}

function assertFails(result, id, pattern) {
  assert.equal(result.ok, false, `expected ${id} to fail`);
  assert.equal(result.level, 'red');
  assert.equal(result.failed.id, id, `failed at ${result.failed.id} (${result.failed.detail}), expected ${id}`);
  if (pattern) assert.match(result.failed.detail, pattern);
}

// ---- happy path ----

test('valid long passes green with a full plan', () => {
  const r = run();
  assert.equal(r.ok, true, r.failed?.detail);
  assert.equal(r.level, 'green');
  assert.equal(r.direction, 'long');
  assert.equal(r.plan.sizeStr, '0.04504');
  assert.ok(r.checks.every((c) => c.status === (c.id === 'execution' ? 'skip' : 'pass')));
  assert.equal(r.checks.length, CHECKS.length);
});

test('valid short passes', () => {
  const r = run({ clipboard: clip(83_742), direction: 'short' });
  assert.equal(r.ok, true, r.failed?.detail);
  assert.equal(r.plan.direction, 'short');
});

test('preview infers direction from stop vs mark', () => {
  assert.equal(run({ direction: null }).direction, 'long');
  assert.equal(run({ direction: null, clipboard: clip(83_742) }).direction, 'short');
  assert.equal(run({ direction: null }).ok, true);
});

test('live equity is used when equitySource is api', () => {
  const r = run({ config: { equitySource: 'api' } });
  assert.equal(r.plan.equity, 908);
  assert.equal(r.plan.sizeStr, '0.04090'); // 9.08 / 222 = 0.040900…
});

// ---- 1. connection ----

test('refuses when the feed is down or reconnecting', () => {
  assertFails(run({ mkt: { wsOpen: false } }), 'connection', /disconnected/);
  assertFails(run({ mkt: { status: 'error', error: 'subscription lost' } }), 'connection', /subscription lost/);
});

test('refuses on a stale mark', () => {
  assertFails(run({ mkt: { markAgeMs: 6_000 } }), 'connection', /mark is 6.0s old/);
  assertFails(run({ mkt: { mark: null, markAgeMs: null } }), 'connection', /no mark/);
});

test('refuses before account data has loaded', () => {
  assertFails(run({ mkt: { account: null } }), 'connection', /account data not loaded/);
});

test('refuses with zero live equity', () => {
  assertFails(run({ config: { equitySource: 'api' }, mkt: { account: account({ equity: 0 }) } }), 'connection', /equity/);
});

// ---- leverage ----

test('refuses when exchange leverage does not match config', () => {
  assertFails(run({ mkt: { account: account({ leverage: { type: 'isolated', value: 10 } }) } }), 'leverage', /expected isolated 20x/);
  assertFails(run({ mkt: { account: account({ leverage: { type: 'cross', value: 20 } }) } }), 'leverage', /cross/);
});

// ---- 2. position already open ----

test('refuses while a position is open', () => {
  const position = { size: 0.045, entryPx: 83_500, unrealizedPnl: 1, liquidationPx: 80_400, marginUsed: 188, leverage: {} };
  assertFails(run({ mkt: { account: account({ position }) } }), 'noPosition', /long 0.045 BTC open/);
});

// ---- 3. resting orders ----

test('refuses with resting BTC orders', () => {
  assertFails(run({ mkt: { account: account({ orders: [{ oid: 1 }] }) } }), 'noOrders', /1 resting BTC order;/);
});

// ---- 4. parse (zero, negative, junk) ----

test('refuses unparseable clipboard content, including zero and negatives', () => {
  for (const [raw, error] of [['0', 'zero or negative'], ['-83,298', 'contains non-price characters'], ['hello', 'contains non-price characters']]) {
    assertFails(run({ clipboard: clip(null, 1_000, { raw, error }) }), 'clipboardParses', new RegExp(error));
  }
});

// ---- 5. stale clipboard ----

test('refuses a stale stop', () => {
  assertFails(run({ clipboard: clip(83_298, 90_001) }), 'clipboardFresh', /copied 90s ago/);
});

test('refuses a stop copied before launch', () => {
  assertFails(run({ clipboard: clip(83_298, Infinity) }), 'clipboardFresh', /before launch/);
  assertFails(run({ clipboard: clip(83_298, null) }), 'clipboardFresh', /before launch/);
});

test('an ageing stop passes amber', () => {
  const r = run({ clipboard: clip(83_298, 61_000) });
  assert.equal(r.ok, true);
  assert.equal(r.level, 'amber');
  assert.match(r.warnings[0], /61s ago/);
});

// ---- 6. magnitude (comma mis-parse) ----

test('refuses a locale mis-parse (83,298 read as 83.298)', () => {
  assertFails(run({ clipboard: clip(83.298) }), 'magnitude', /wrong instrument or mis-parse/);
});

test('refuses a price from another instrument', () => {
  assertFails(run({ clipboard: clip(3_150) }), 'magnitude');
});

// ---- 7. wrong side ----

test('refuses a long with the stop above mark', () => {
  assertFails(run({ clipboard: clip(83_742), direction: 'long' }), 'side', /LONG pressed but stop 83,742 is above mark/);
});

test('refuses a short with the stop below mark', () => {
  assertFails(run({ clipboard: clip(83_298), direction: 'short' }), 'side', /SHORT pressed but stop 83,298 is below mark/);
});

test('refuses a stop exactly at mark', () => {
  assertFails(run({ clipboard: clip(83_520) }), 'side', /equals mark/);
});

// ---- 8. distance band ----

test('refuses a too-tight stop', () => {
  assertFails(run({ clipboard: clip(83_480) }), 'distance', /40 USD away \(min 80\)/);
});

test('refuses below the percentage minimum', () => {
  assertFails(run({ config: { minStopDistance: 1, minStopDistancePct: 0.001 }, clipboard: clip(83_450) }), 'distance', /min 0.10%/);
});

test('refuses a too-wide stop', () => {
  const stop = 83_520 * (1 - 0.035);
  assertFails(run({ clipboard: clip(Math.round(stop)) }), 'distance', /max 3.00%/);
});

test('boundary: exactly the minimum distance passes', () => {
  assert.equal(run({ clipboard: clip(83_440) }).ok, true);
});

// ---- 9. size ----

test('refuses when size rounds to zero or is below minimum notional', () => {
  assertFails(run({ config: { equityFixed: 0.01 } }), 'size', /rounds to zero/);
  // 20 × 0.1% = 0.02 USD risk → 0.00009 BTC ≈ 7.5 USD notional
  assertFails(run({ config: { equityFixed: 20, riskPct: 0.001 } }), 'size', /below exchange minimum 10/);
});

// ---- 10. insufficient margin ----

test('refuses when required margin exceeds 80% of free collateral', () => {
  // The spec's 40-point example: 0.25 BTC ≈ 20,900 notional ≈ 1,045 margin at 20x.
  assertFails(run({ config: { minStopDistance: 10, minStopDistancePct: 0.0001 }, clipboard: clip(83_480) }), 'margin', /needs 1,04\d.* USDC margin/);
});

test('uses the side-specific free collateral', () => {
  const r = run({ clipboard: clip(83_742), direction: 'short', mkt: { account: account({ availableToTrade: { buy: 908, sell: 100 } }) } });
  assertFails(r, 'margin');
});

test('margin over half of free collateral passes amber', () => {
  const r = run({ mkt: { account: account({ availableToTrade: { buy: 300, sell: 300 } }) } });
  assert.equal(r.ok, true, r.failed?.detail);
  assert.equal(r.level, 'amber');
  assert.match(r.warnings.join(), /Margin 6\d\.\d\d%/);
});

// ---- 11. liquidation ----

test('refuses when liquidation would come before the stop', () => {
  // Widen the band so a 4% stop gets past check 8: at 20x liquidation is ~3.8% away.
  const stop = Math.round(83_520 * 0.96);
  const r = run({ config: { maxStopDistancePct: 0.05 }, clipboard: clip(stop), mkt: { account: account({ availableToTrade: { buy: 5_000, sell: 5_000 } }) } });
  assertFails(r, 'liquidation', /need 1.2× clearance/);
});

test('the default 3% max stop clears liquidation in both directions', () => {
  const longStop = Math.ceil(83_520 * 0.97);
  const shortStop = Math.floor(83_520 * 1.03);
  assert.equal(run({ clipboard: clip(longStop) }).ok, true, run({ clipboard: clip(longStop) }).failed?.detail);
  const short = run({ clipboard: clip(shortStop), direction: 'short' });
  assert.equal(short.ok, true, short.failed?.detail);
});

// ---- ordering and dry run without an account ----

test('first failure stops evaluation; later checks are not run', () => {
  const r = run({ mkt: { account: account({ orders: [{ oid: 1 }] }) }, clipboard: clip(83_298, 200_000) });
  assert.equal(r.failed.id, 'noOrders');
  assert.equal(r.checks.find((c) => c.id === 'clipboardFresh').status, 'notRun');
});

test('the plan is still computed when a check fails', () => {
  const r = run({ clipboard: clip(83_298, 200_000) });
  assert.equal(r.ok, false);
  assert.equal(r.plan.sizeStr, '0.04504');
});

test('dry run without an address skips account checks and warns', () => {
  const r = run({ config: { mode: 'dryRun', accountAddress: '' }, mkt: { account: null } });
  assert.equal(r.ok, true, r.failed?.detail);
  assert.equal(r.level, 'amber');
  for (const id of ['leverage', 'noPosition', 'noOrders']) assert.equal(r.checks.find((c) => c.id === id).status, 'skip');
  assert.equal(r.freeCollateral, 1000);
});

test('orders-enabled check: skipped in dry run, required on testnet and live', () => {
  assert.equal(run().checks[0].status, 'skip');
  assert.equal(run({ config: { mode: 'testnet' } }).ok, true);
  assertFails(run({ config: { mode: 'testnet' }, execution: { ready: false, error: 'API wallet not approved' } }), 'execution', /not approved/);
  assertFails(run({ config: { mode: 'testnet' }, execution: null }), 'execution', /missing/);
  assert.equal(run({ config: { mode: 'live' } }).ok, true);
  assertFails(run({ config: { mode: 'live' }, liveArmed: false }), 'execution', /LIVE is not armed for this session/);
  // An unready executor is reported before arming: arming wouldn't help.
  assertFails(run({ config: { mode: 'live' }, liveArmed: false, execution: { ready: false, error: 'API wallet not approved' } }), 'execution', /not approved/);
  // Arming only matters in live.
  assert.equal(run({ config: { mode: 'testnet' }, liveArmed: false }).ok, true);
  assertFails(run({ config: { mode: 'live' }, execution: { ready: false, error: 'API wallet expired' } }), 'execution', /expired/);
});

test('testnet and live never skip account checks', () => {
  assertFails(run({ config: { mode: 'testnet', accountAddress: '' }, mkt: { account: null } }), 'connection', /account data not loaded/);
});

// ---- 12. mark moved ----

test('markMoved refuses beyond the slippage limit', () => {
  const plan = { mark: 83_520 };
  assert.equal(markMoved(plan, 83_520 * 1.0009, 10), null);
  assert.match(markMoved(plan, 83_520 * 1.0011, 10), /moved 11.0bp/);
  assert.match(markMoved(plan, 83_520 * 0.9989, 10), /moved 11.0bp/);
  assert.match(markMoved(plan, null, 10), /no current mark/);
});
