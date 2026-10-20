import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActions, PRESS_COOLDOWN_MS } from '../src/main/actions.js';
import { registerHotkeys } from '../src/main/hotkeys.js';
import { createStore } from '../src/main/store.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const ADDRESS = '0x' + 'a'.repeat(40);

function setup({ config = {}, clip = {}, account = {}, refresh } = {}) {
  const env = { time: 100_000, mark: 83_520, sounds: [], logs: [], refreshes: 0 };
  const cfg = { ...DEFAULTS, accountAddress: ADDRESS, equitySource: 'fixed', equityFixed: 1000, ...config };
  const acct = { equity: 908, equityBasis: 'x', position: null, orders: [], leverage: { type: 'isolated', value: 20 }, availableToTrade: { buy: 908, sell: 908 }, ...account };
  const market = {
    snapshot: () => ({ network: 'mainnet', status: 'ready', error: null, wsOpen: true, spec: SPEC, mark: env.mark, markAgeMs: 300, account: acct }),
    refreshAccount: refresh ?? (async () => { env.refreshes++; return acct; }),
  };
  const watcher = { snapshot: () => ({ raw: '83,298', value: 83_298, error: null, capturedAt: 0, ageMs: 5_000, ...clip }) };
  const now = () => env.time;
  const store = createStore({ config: cfg, watcher, market, now });
  const actions = createActions({ config: cfg, store, market, playSound: (k) => env.sounds.push(k), log: (l) => env.logs.push(l), now });
  return { env, store, actions, market };
}

test('dry run: valid press is accepted, plays the accepted sound and logs the order', async () => {
  const { env, store, actions } = setup();
  await actions.long();
  const last = store.snapshot().lastAction;
  assert.equal(last.kind, 'accepted');
  assert.match(last.text, /DRY RUN LONG 0.04504 BTC, stop 83298, risk 10.00 USD \[A\] \(not sent\)/);
  assert.deepEqual(env.sounds, ['accepted']);
  const { action, markAtPress } = JSON.parse(env.logs[0].replace(/^.*would send: /, ''));
  assert.equal(markAtPress, 83_520);
  assert.equal(action.grouping, 'normalTpsl');
  assert.deepEqual(action.orders[0], { a: 0, b: true, p: '83562', s: '0.04504', r: false, t: { limit: { tif: 'Ioc' } }, c: '0x(entry)' });
  assert.deepEqual(action.orders[1], { a: 0, b: false, p: '82465', s: '0.04504', r: true, t: { trigger: { isMarket: true, triggerPx: '83298', tpsl: 'sl' } }, c: '0x(stop)' });
});

test('the account is refreshed from REST before the gate runs', async () => {
  const { env, actions } = setup();
  await actions.long();
  assert.equal(env.refreshes, 1);
});

test('a failed refresh refuses the trade', async () => {
  const { env, store, actions } = setup({ refresh: async () => { throw new Error('timeout'); } });
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /could not refresh account \(timeout\)/);
  assert.deepEqual(env.sounds, ['refused']);
});

test('a failing gate refuses with the check and reason', async () => {
  const { env, store, actions } = setup();
  await actions.short(); // stop is below mark
  const last = store.snapshot().lastAction;
  assert.equal(last.kind, 'refused');
  assert.match(last.text, /Refused SHORT: Stop on correct side: SHORT pressed/);
  assert.deepEqual(env.sounds, ['refused']);
});

test('check 12: refuses if the mark moves during the refresh', async () => {
  const { env, store, actions } = setup({
    refresh: async () => { env.mark = 83_520 * 1.0015; return null; },
  });
  // The stop is still valid against the new mark, so only check 12 can catch this.
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /Refused LONG: mark moved 15\.0bp since the press \(max 10bp\)/);
  assert.deepEqual(env.sounds, ['refused']);
});

test('check 12: a small move during the refresh is fine', async () => {
  const { env, store, actions } = setup({
    refresh: async () => { env.mark = 83_520 * 1.0005; return null; },
  });
  await actions.long();
  assert.equal(store.snapshot().lastAction.kind, 'accepted');
});

test('presses during a running sequence are ignored', async () => {
  let release;
  const { env, store, actions } = setup({ refresh: () => new Promise((r) => (release = r)) });
  const first = actions.long();
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /ignored: previous press still running/);
  assert.equal(store.snapshot().busy, true);
  release();
  await first;
  assert.equal(store.snapshot().busy, false);
  assert.deepEqual(env.sounds, ['accepted']);
});

test('auto-repeat within the cooldown is ignored; after it, presses work again', async () => {
  const { env, store, actions } = setup();
  await actions.long();
  env.time += PRESS_COOLDOWN_MS - 1;
  await actions.long();
  assert.match(store.snapshot().lastAction.text, /ignored: previous press still settling/);
  env.time += 2;
  await actions.long();
  assert.equal(store.snapshot().lastAction.kind, 'accepted');
  assert.deepEqual(env.sounds, ['accepted', 'accepted']);
});

test('testnet and live without an executor refuse', async () => {
  const testnet = setup({ config: { mode: 'testnet' } });
  await testnet.actions.long();
  assert.match(testnet.store.snapshot().lastAction.text, /Orders enabled: order executor missing/);
  assert.deepEqual(testnet.env.sounds, ['refused']);

  const live = setup({ config: { mode: 'live' } });
  await live.actions.long();
  assert.match(live.store.snapshot().lastAction.text, /Orders enabled: order executor missing/);
});

test('dry run panic describes what it would do, without a clipboard', async () => {
  const position = { size: -0.045, entryPx: 83_500, unrealizedPnl: 0, liquidationPx: 86_000, marginUsed: 188, stop: null };
  const { store, actions } = setup({ account: { position, orders: [{ oid: 1 }, { oid: 2 }] }, clip: { value: null, raw: null, error: 'clipboard is empty' } });
  await actions.panic();
  assert.match(store.snapshot().lastAction.text, /DRY RUN panic: close short 0.045 BTC and cancel 2 BTC orders/);
});

test('dry run panic when flat', async () => {
  const { store, actions } = setup();
  await actions.panic();
  assert.match(store.snapshot().lastAction.text, /nothing to do/);
});

test('hotkey registration reports failures without throwing', () => {
  const registered = [];
  const globalShortcut = {
    register(accel, fn) {
      if (accel === 'Ctrl+Down') return false; // owned by another app
      if (accel === 'Bogus+') throw new Error('Invalid accelerator');
      registered.push([accel, fn]);
      return true;
    },
  };
  const handlers = { long() {}, short() {}, panic() {} };
  const result = registerHotkeys({ globalShortcut, handlers, config: { hotkeyLong: 'Ctrl+Up', hotkeyShort: 'Ctrl+Down', hotkeyPanic: 'Bogus+' } });
  assert.deepEqual(result, [
    { action: 'long', accelerator: 'Ctrl+Up', registered: true },
    { action: 'short', accelerator: 'Ctrl+Down', registered: false },
    { action: 'panic', accelerator: 'Bogus+', registered: false, error: 'Invalid accelerator' },
  ]);
  assert.equal(registered[0][1], handlers.long);
});
