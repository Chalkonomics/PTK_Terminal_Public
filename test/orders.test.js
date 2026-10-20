import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessOutcome, buildOrderAction, classifySubmission, createExecutor, newCloid } from '../src/main/orders.js';
import { createActions } from '../src/main/actions.js';
import { createStore } from '../src/main/store.js';
import { computePlan } from '../src/main/sizing.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const TESTNET_SPEC = { ...SPEC, assetId: 3 };
const PLAN = computePlan({ direction: 'long', mark: 83_520, stop: 83_298, equity: 1000, config: DEFAULTS, spec: SPEC });

// ---- building the action ----

test('cloids are 16-byte hex and unique', () => {
  const a = newCloid();
  assert.match(a, /^0x[0-9a-f]{32}$/);
  assert.notEqual(a, newCloid());
});

test('long action: IOC buy entry + reduce-only sell stop, grouped normalTpsl', () => {
  const action = buildOrderAction(PLAN, TESTNET_SPEC, { entryCloid: '0x01', stopCloid: '0x02' });
  assert.deepEqual(action, {
    orders: [
      { a: 3, b: true, p: '83562', s: '0.04504', r: false, t: { limit: { tif: 'Ioc' } }, c: '0x01' },
      { a: 3, b: false, p: '82465', s: '0.04504', r: true, t: { trigger: { isMarket: true, triggerPx: '83298', tpsl: 'sl' } }, c: '0x02' },
    ],
    grouping: 'normalTpsl',
  });
});

test('short action mirrors the long', () => {
  const plan = computePlan({ direction: 'short', mark: 83_520, stop: 83_742, equity: 1000, config: DEFAULTS, spec: SPEC });
  const [entry, stop] = buildOrderAction(plan, SPEC, { entryCloid: '0x01', stopCloid: '0x02' }).orders;
  assert.equal(entry.b, false);
  assert.equal(entry.p, '83478');
  assert.equal(stop.b, true);
  assert.equal(stop.r, true);
  assert.equal(stop.t.trigger.triggerPx, '83742');
  assert.ok(Number(stop.p) > 83_742, 'stop limit must be beyond the trigger for a buy stop');
});

// ---- classifying the response ----

const ok = (statuses) => ({ status: 'ok', response: { type: 'order', data: { statuses } } });
const apiError = (response) => Object.assign(new Error('api'), { name: 'ApiRequestError', response });

test('filled entry with accepted stop', () => {
  const c = classifySubmission({ response: ok([{ filled: { totalSz: '0.04504', avgPx: '83530.5', oid: 11 } }, 'waitingForTrigger']) });
  assert.deepEqual(c, { kind: 'responded', entry: { filled: true, totalSz: 0.04504, avgPx: 83_530.5, oid: 11 }, stop: { accepted: true, status: 'waitingForTrigger' } });
});

test('stop accepted as a resting trigger', () => {
  const c = classifySubmission({ response: ok([{ filled: { totalSz: '0.04504', avgPx: '83530.5', oid: 11 } }, { resting: { oid: 12 } }]) });
  assert.deepEqual(c.stop, { accepted: true, oid: 12 });
});

test('filled entry with rejected stop is recovered from the thrown error', () => {
  const err = apiError(ok([{ filled: { totalSz: '0.04504', avgPx: '83530.5', oid: 11 } }, { error: 'Invalid TP/SL price' }]));
  const c = classifySubmission({ error: err });
  assert.equal(c.kind, 'responded');
  assert.equal(c.entry.filled, true);
  assert.deepEqual(c.stop, { accepted: false, error: 'Invalid TP/SL price' });
});

test('IOC that cannot match', () => {
  const err = apiError(ok([{ error: 'Order could not immediately match against any resting orders.' }, 'waitingForFill']));
  const c = classifySubmission({ error: err });
  assert.equal(c.entry.filled, false);
  assert.match(c.entry.error, /could not immediately match/);
});

test('top-level rejection means nothing executed', () => {
  const c = classifySubmission({ error: apiError({ status: 'err', response: 'User or API Wallet 0xabc does not exist.' }) });
  assert.deepEqual(c, { kind: 'rejected', reason: 'User or API Wallet 0xabc does not exist.' });
});

test('timeouts and network failures are ambiguous', () => {
  const c = classifySubmission({ error: Object.assign(new Error('Request timed out after 4000 ms'), { name: 'HttpRequestError' }) });
  assert.deepEqual(c, { kind: 'ambiguous', reason: 'Request timed out after 4000 ms' });
  assert.equal(classifySubmission({ response: { status: 'ok' } }).kind, 'ambiguous');
});

// ---- assessing the outcome from the exchange's state ----

const FILLED = classifySubmission({ response: ok([{ filled: { totalSz: '0.04504', avgPx: '83530.5', oid: 11 } }, 'waitingForTrigger']) });
const account = (position, orders = []) => ({ position, orders });
const pos = (size, stop) => ({ size, entryPx: 83_530.5, stop });
const FULL_STOP = { oid: 12, triggerPx: 83_298, coversSize: true };

test('position with a full stop is protected', () => {
  assert.equal(assessOutcome(FILLED, account(pos(0.04504, FULL_STOP)), PLAN).kind, 'protected');
});

test('position without a stop is unprotected, with the stop error attached', () => {
  const sub = { ...FILLED, stop: { accepted: false, error: 'Invalid TP/SL price' } };
  const o = assessOutcome(sub, account(pos(0.04504, null)), PLAN);
  assert.equal(o.kind, 'unprotected');
  assert.match(o.reason, /no stop on the exchange \(stop error: Invalid TP\/SL price\)/);
});

test('a partial stop is unprotected', () => {
  const o = assessOutcome(FILLED, account(pos(0.04504, { ...FULL_STOP, coversSize: false })), PLAN);
  assert.equal(o.kind, 'unprotected');
  assert.match(o.reason, /only part/);
});

test('exchange state wins over an ambiguous response', () => {
  assert.equal(assessOutcome({ kind: 'ambiguous', reason: 'timeout' }, account(pos(0.04504, FULL_STOP)), PLAN).kind, 'protected');
  assert.equal(assessOutcome({ kind: 'ambiguous', reason: 'timeout' }, account(null), PLAN).kind, 'notFilled');
});

test('a position on the wrong side is never called protected', () => {
  assert.equal(assessOutcome(FILLED, account(pos(-0.04504, FULL_STOP)), PLAN).kind, 'unknown');
});

test('fill reported but flat is unknown (caller re-checks)', () => {
  assert.equal(assessOutcome(FILLED, account(null), PLAN).kind, 'unknown');
});

test('no fill: notFilled, with leftover orders counted', () => {
  const sub = classifySubmission({ error: apiError(ok([{ error: 'Order could not immediately match' }, 'waitingForFill'])) });
  assert.deepEqual(assessOutcome(sub, account(null, [{ oid: 5 }]), PLAN), { kind: 'notFilled', reason: 'Order could not immediately match', leftoverOrders: 1 });
});

test('no account read-back is unknown', () => {
  assert.equal(assessOutcome(FILLED, null, PLAN).kind, 'unknown');
});

// ---- full press flow against a fake exchange ----

const BASE_ACCOUNT = { equity: 908, equityBasis: 'x', leverage: { type: 'isolated', value: 20 }, availableToTrade: { buy: 908, sell: 908 }, position: null, orders: [] };
const STOP_ORDER = { oid: 12, side: 'A', size: 0.04504, isTrigger: true, triggerPx: 83_298, reduceOnly: true, isPositionTpsl: false, orderType: 'Stop Market' };
const LONG = (size = 0.04504, stop = FULL_STOP) => ({ size, entryPx: 83_530.5, unrealizedPnl: 0, liquidationPx: 80_400, marginUsed: 188, leverage: {}, stop });

function harness({ submission, readBacks, ready = true, mode = 'testnet', armed = true }) {
  const env = { sounds: [], sent: [], slept: false };
  let reads = 0;
  const config = { ...DEFAULTS, mode, accountAddress: '0x' + 'a'.repeat(40), equitySource: 'fixed', equityFixed: 1000 };
  const market = {
    snapshot: () => ({ network: 'testnet', status: 'ready', error: null, wsOpen: true, spec: TESTNET_SPEC, mark: 83_520, markAgeMs: 300, account: BASE_ACCOUNT }),
    // First read is the pre-gate refresh; the rest are post-submit read-backs.
    refreshAccount: async () => (reads++ === 0 ? BASE_ACCOUNT : { ...BASE_ACCOUNT, ...readBacks[Math.min(reads - 2, readBacks.length - 1)] }),
  };
  const watcher = { snapshot: () => ({ raw: '83,298', value: 83_298, error: null, capturedAt: 0, ageMs: 5_000 }) };
  const executor = { status: { ready, error: ready ? null : 'API wallet not approved' }, submit: async (a) => { env.sent.push(a); return submission; } };
  const store = createStore({ config, watcher, market, execution: executor.status, liveArmed: armed });
  const actions = createActions({ config, store, market, executor, playSound: (k) => env.sounds.push(k), log: () => {}, sleep: async () => { env.slept = true; } });
  return { env, store, actions };
}

test('press: filled with stop attached reports the fill and slippage', async () => {
  const { env, store, actions } = harness({ submission: FILLED, readBacks: [{ position: LONG(), orders: [STOP_ORDER] }] });
  await actions.long();
  const last = store.snapshot().lastAction;
  assert.equal(last.kind, 'accepted', last.text);
  assert.match(last.text, /^FILLED LONG 0.04504 BTC @ 83530.5 \(slip \+1.3bp\), stop 83298 on exchange \[A\]$/);
  assert.deepEqual(env.sounds, ['accepted']);
  const [entry, stop] = env.sent[0].orders;
  assert.equal(entry.a, 3);
  assert.notEqual(entry.c, stop.c);
});

test('press: partial fill is reported', async () => {
  const { store, actions } = harness({ submission: FILLED, readBacks: [{ position: LONG(0.03) }] });
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /partial: 0.03 of 0.04504/);
});

test('press: IOC miss is a refusal with nothing open', async () => {
  const sub = classifySubmission({ error: apiError(ok([{ error: 'Order could not immediately match' }, 'waitingForFill'])) });
  const { env, store, actions } = harness({ submission: sub, readBacks: [{}] });
  await actions.long();
  assert.equal(store.snapshot().lastAction.text, 'LONG not filled: Order could not immediately match. Nothing open.');
  assert.deepEqual(env.sounds, ['refused']);
});

test('press: a timeout is resolved from the exchange state', async () => {
  const { store, actions } = harness({ submission: { kind: 'ambiguous', reason: 'timeout' }, readBacks: [{ position: LONG(), orders: [STOP_ORDER] }] });
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /^FILLED LONG/);
});

test('press: nothing is sent when the executor is not ready', async () => {
  const { env, store, actions } = harness({ submission: FILLED, readBacks: [{}], ready: false });
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /Orders enabled: API wallet not approved/);
  assert.equal(env.sent.length, 0);
});

test('press: live mode refuses until armed for the session', async () => {
  const { env, store, actions } = harness({ submission: FILLED, readBacks: [{}], mode: 'live', armed: false });
  assert.equal(store.snapshot().needsArm, true);
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /LIVE is not armed for this session/);
  assert.equal(env.sent.length, 0);
  store.armLive();
  assert.equal(store.snapshot().needsArm, false);
});

test('press: live mode sends through the same path as testnet', async () => {
  const { env, store, actions } = harness({ submission: FILLED, readBacks: [{ position: LONG(), orders: [STOP_ORDER] }], mode: 'live' });
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /^FILLED LONG/);
  assert.equal(env.sent.length, 1);
});

test('fault injection can never activate outside testnet', () => {
  const previous = process.env.PTK_FAULT;
  process.env.PTK_FAULT = 'no-stop';
  try {
    for (const mode of ['live', 'dryRun']) {
      const ex = createExecutor({ config: { ...DEFAULTS, mode, accountAddress: '0x' + 'a'.repeat(40) }, rootDir: '.', log: () => {} });
      assert.equal(ex.status.fault, null, mode);
    }
    const tn = createExecutor({ config: { ...DEFAULTS, mode: 'testnet', accountAddress: '0x' + 'a'.repeat(40) }, rootDir: '.', log: () => {} });
    assert.equal(tn.status.fault, 'no-stop');
  } finally {
    if (previous === undefined) delete process.env.PTK_FAULT;
    else process.env.PTK_FAULT = previous;
  }
});
