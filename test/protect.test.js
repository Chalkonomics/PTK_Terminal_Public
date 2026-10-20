import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/main/actions.js';
import { createStore } from '../src/main/store.js';
import { findStop } from '../src/main/account.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

// A stateful simulated exchange: positions open and close, stops attach or are
// rejected, closes fill only at a given slippage, reads can fail. Remediation is
// judged by the state the exchange ends in, not by what the code claims.

const MARK = 83_520;

function simulate({
  entryFills = true,
  stopAccepted = true,
  retryStopAccepted = true,
  closeFillsAtBps = 50, // a close fills only if its limit is at least this far through the mark
  ambiguousSubmit = false,
  failReadsAfterSubmit = 0,
  executorReady = true,
  initial = {},
  mode = 'testnet',
} = {}) {
  const ex = { position: initial.position ?? null, orders: initial.orders ?? [], nextOid: 100, calls: [], submitted: false, failReads: 0 };
  const env = { sounds: [], logs: [] };

  const stopOrder = (isLong, size, triggerPx) => ({
    oid: ex.nextOid++, side: isLong ? 'A' : 'B', size, isTrigger: true, triggerPx, limitPx: 0,
    reduceOnly: true, isPositionTpsl: false, orderType: 'Stop Market',
  });

  const executor = {
    status: { ready: executorReady, error: executorReady ? null : 'API wallet not approved' },
    async submit(action) {
      ex.calls.push('submit');
      ex.submitted = true;
      ex.failReads = failReadsAfterSubmit;
      const [entry, stop] = action.orders;
      const size = Number(entry.s);
      if (entryFills && !ex.closeOnFill) ex.position = { size: entry.b ? size : -size, entryPx: MARK + 9 };
      if (entryFills && stopAccepted && !ex.closeOnFill) ex.orders.push(stopOrder(entry.b, size, Number(stop.t.trigger.triggerPx)));
      if (ambiguousSubmit) return { kind: 'ambiguous', reason: 'Request timed out after 4000 ms' };
      return {
        kind: 'responded',
        entry: entryFills ? { filled: true, totalSz: size, avgPx: MARK + 9, oid: 1 } : { filled: false, error: 'Order could not immediately match' },
        stop: entryFills && stopAccepted ? { accepted: true, status: 'waitingForTrigger' } : { accepted: false, error: 'Invalid TP/SL price' },
      };
    },
    async placeStop({ isLong, sizeStr, triggerPxStr }) {
      ex.calls.push('placeStop');
      if (!retryStopAccepted) return { ok: false, error: 'order 0: Invalid TP/SL price', statuses: [{ error: 'Invalid TP/SL price' }] };
      ex.orders.push(stopOrder(isLong, Number(sizeStr), Number(triggerPxStr)));
      return { ok: true, statuses: [{ resting: { oid: ex.nextOid } }] };
    },
    async closePosition({ isLong, limitPxStr }) {
      const bps = (Math.abs(Number(limitPxStr) - MARK) / MARK) * 10_000;
      ex.calls.push(`close@${Math.round(bps)}bp`);
      if (bps + 1 >= closeFillsAtBps && ex.position && (ex.position.size > 0) === isLong) {
        ex.position = null;
        ex.orders = ex.orders.filter((o) => !o.reduceOnly); // Hyperliquid drops reduce-only orders once flat
      }
      return { ok: true, statuses: [{ filled: {} }] };
    },
    async cancel({ oids }) {
      ex.calls.push(`cancel×${oids.length}`);
      ex.orders = ex.orders.filter((o) => !oids.includes(o.oid));
      return { ok: true, statuses: oids.map(() => 'success') };
    },
  };

  const account = () => ({
    equity: 908, equityBasis: 'x', leverage: { type: 'isolated', value: 20 }, availableToTrade: { buy: 908, sell: 908 },
    orders: ex.orders.map((o) => ({ ...o })),
    position: ex.position && { ...ex.position, unrealizedPnl: 0, liquidationPx: 80_400, marginUsed: 188, leverage: {}, stop: findStop(ex.position, ex.orders) },
  });

  const config = { ...DEFAULTS, mode, accountAddress: '0x' + 'a'.repeat(40), equitySource: 'fixed', equityFixed: 1000 };
  // The gate sees a flat account (it runs before the trade); read-backs see the simulated exchange.
  const flat = { ...account(), position: null, orders: [] };
  const market = {
    snapshot: () => ({ network: 'testnet', status: 'ready', error: null, wsOpen: true, spec: SPEC, mark: MARK, markAgeMs: 300, account: initial.position ? account() : flat }),
    async refreshAccount() {
      if (ex.failReads > 0) {
        ex.failReads--;
        throw new Error('network down');
      }
      return account();
    },
  };
  const watcher = { snapshot: () => ({ raw: '83,298', value: 83_298, error: null, capturedAt: 0, ageMs: 5_000 }) };
  const store = createStore({ config, watcher, market, execution: executor.status });
  const actions = createActions({ config, store, market, executor, playSound: (k) => env.sounds.push(k), log: (l) => env.logs.push(l), sleep: async () => {} });
  return { ex, env, store, actions, last: () => store.snapshot().lastAction };
}

// ---- spec failure table ----

test('entry rejected: nothing happened, nothing remediated', async () => {
  const s = simulate({ entryFills: false });
  await s.actions.long();
  assert.equal(s.last().text, 'LONG not filled: Order could not immediately match. Nothing open.');
  assert.deepEqual(s.ex.calls, ['submit']);
  assert.equal(s.ex.position, null);
});

test('entry filled, stop accepted: normal path, no extra calls', async () => {
  const s = simulate();
  await s.actions.long();
  assert.match(s.last().text, /^FILLED LONG 0.04504 BTC/);
  assert.deepEqual(s.ex.calls, ['submit']);
  assert.deepEqual(s.env.sounds, ['accepted']);
});

test('stop rejected, retry succeeds: protected, flagged as retried', async () => {
  const s = simulate({ stopAccepted: false });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'placeStop']);
  assert.ok(s.ex.position, 'position kept');
  assert.equal(findStop(s.ex.position, s.ex.orders).coversSize, true, 'exchange now holds a full stop');
  assert.equal(s.last().kind, 'refused'); // amber: worth a look, but safe
  assert.match(s.last().text, /attached on RETRY; first attempt: no stop on the exchange/);
  assert.deepEqual(s.env.sounds, ['accepted']);
});

test('stop rejected twice: position is flattened at market', async () => {
  const s = simulate({ stopAccepted: false, retryStopAccepted: false });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'placeStop', 'close@50bp']);
  assert.equal(s.ex.position, null, 'exchange is flat');
  assert.equal(s.last().kind, 'error');
  assert.match(s.last().text, /LONG FLATTENED: entry filled but the stop could not be attached/);
  assert.deepEqual(s.env.sounds, ['danger']);
});

test('flatten widens its limit until the close fills', async () => {
  const s = simulate({ stopAccepted: false, retryStopAccepted: false, closeFillsAtBps: 200 });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'placeStop', 'close@50bp', 'close@200bp']);
  assert.equal(s.ex.position, null);
  assert.match(s.last().text, /FLATTENED/);
});

test('flatten that never fills raises the loudest alarm', async () => {
  const s = simulate({ stopAccepted: false, retryStopAccepted: false, closeFillsAtBps: 10_000 });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'placeStop', 'close@50bp', 'close@200bp', 'close@500bp']);
  assert.ok(s.ex.position, 'still open (simulated unfillable book)');
  assert.match(s.last().text, /COULD NOT CONFIRM FLAT .* Close the BTC position in the Hyperliquid UI NOW/);
  assert.deepEqual(s.env.sounds, ['danger']);
});

test('timeout: the entry is never re-sent; existing stop is found and accepted', async () => {
  const s = simulate({ ambiguousSubmit: true });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit']);
  assert.match(s.last().text, /^FILLED LONG/);
});

test('timeout with an unstopped position: stop attached, entry not re-sent', async () => {
  const s = simulate({ ambiguousSubmit: true, stopAccepted: false });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'placeStop']);
  assert.equal(s.ex.calls.filter((c) => c === 'submit').length, 1);
  assert.match(s.last().text, /attached on RETRY/);
});

test('timeout and the exchange cannot be read: blind reduce-only close is sent', async () => {
  const s = simulate({ ambiguousSubmit: true, stopAccepted: false, failReadsAfterSubmit: 99 });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'close@200bp']);
  assert.equal(s.ex.position, null, 'blind close flattened it');
  assert.match(s.last().text, /COULD NOT CONFIRM FLAT \(cannot read the exchange; blind reduce-only close sent\)/);
});

test('reads recover during reconciliation: proceeds normally', async () => {
  const s = simulate({ ambiguousSubmit: true, stopAccepted: false, failReadsAfterSubmit: 3 });
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit', 'placeStop']);
  assert.match(s.last().text, /attached on RETRY/);
});

test('fill reported but flat after reconciling is a real trade that already closed, not a miss', async () => {
  const s = simulate();
  s.ex.closeOnFill = true; // exchange fills, then the position closes at once (e.g. stop already through the market)
  await s.actions.long();
  assert.deepEqual(s.ex.calls, ['submit'], 'no stop retry or flatten when already flat');
  assert.match(s.last().text, /LONG FILLED 0.04504 BTC @ 83529 but the position is already closed/);
  assert.equal(s.last().kind, 'refused');
});

test('leftover orders after a missed entry are cancelled', async () => {
  const s = simulate({ entryFills: false, initial: { orders: [] } });
  s.ex.orders.push({ oid: 7, side: 'A', size: 0.045, isTrigger: true, triggerPx: 83_298, reduceOnly: true, isPositionTpsl: false, orderType: 'Stop Market' });
  // Make the read-back report the leftover; the gate itself sees a flat, order-free account.
  await s.actions.long();
  assert.ok(s.ex.calls.includes('cancel×1'), s.ex.calls.join());
  assert.equal(s.ex.orders.length, 0);
});

// ---- panic ----

test('panic cancels every BTC order and flattens', async () => {
  const position = { size: 0.045, entryPx: 83_500 };
  const s = simulate({ initial: { position, orders: [] } });
  s.ex.orders.push({ oid: 9, side: 'A', size: 0.045, isTrigger: true, triggerPx: 83_298, reduceOnly: true, isPositionTpsl: false, orderType: 'Stop Market' });
  s.ex.orders.push({ oid: 10, side: 'B', size: 0.01, isTrigger: false, triggerPx: null, reduceOnly: false, isPositionTpsl: false, orderType: 'Limit' });
  await s.actions.panic();
  assert.deepEqual(s.ex.calls, ['cancel×2', 'close@50bp']);
  assert.equal(s.ex.position, null);
  assert.equal(s.ex.orders.length, 0);
  assert.equal(s.last().text, 'PANIC done: closed long 0.045 BTC, cancelled 2 order(s). Flat confirmed.');
});

test('panic when already flat', async () => {
  const s = simulate();
  await s.actions.panic();
  assert.equal(s.last().text, 'PANIC done: already flat, no orders. Flat confirmed.');
});

test('panic that cannot flatten alarms', async () => {
  const s = simulate({ initial: { position: { size: -0.03, entryPx: 83_500 } }, closeFillsAtBps: 10_000 });
  await s.actions.panic();
  assert.ok(s.ex.position);
  assert.match(s.last().text, /PANIC: could not confirm flat/);
  assert.deepEqual(s.env.sounds, ['danger']);
});

test('panic without a ready executor tells the trader to use the UI', async () => {
  const s = simulate({ executorReady: false });
  await s.actions.panic();
  assert.match(s.last().text, /PANIC FAILED: order executor not ready \(API wallet not approved\)/);
});

test('presses are ignored while panic runs', async () => {
  const s = simulate({ initial: { position: { size: 0.045, entryPx: 83_500 } } });
  const panicking = s.actions.panic();
  await s.actions.long();
  assert.equal(s.last().text, 'LONG press ignored: panic in progress');
  await panicking;
  assert.ok(!s.ex.calls.includes('submit'));
});

test('panic works in LIVE even before the session is armed', async () => {
  const s = simulate({ mode: 'live', initial: { position: { size: 0.045, entryPx: 83_500 } } });
  assert.equal(s.store.snapshot().needsArm, true);
  await s.actions.long();
  assert.ok(!s.ex.calls.includes('submit'), 'presses refused while disarmed');
  await s.actions.panic();
  assert.equal(s.ex.position, null, 'panic flattened without arming');
  assert.match(s.last().text, /^PANIC done: closed long 0.045 BTC/);
});
