import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/main/store.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const CONFIG = { ...DEFAULTS, accountAddress: '0x' + 'a'.repeat(40), equitySource: 'fixed', equityFixed: 900 };

function setup({ clip = {}, account = {}, config = {} } = {}) {
  const market = {
    snapshot: () => ({
      network: 'mainnet', status: 'ready', error: null, wsOpen: true, spec: SPEC, mark: 83_520, markAgeMs: 300,
      account: {
        equity: 908.09, equityBasis: 'unified (spot USDC)', position: null, orders: [],
        leverage: { type: 'isolated', value: 20 }, availableToTrade: { buy: 908, sell: 908 }, ...account,
      },
    }),
  };
  const watcher = { snapshot: () => ({ raw: '83,298', value: 83_298, error: null, capturedAt: 0, ageMs: 5_000, ...clip }) };
  return createStore({ config: { ...CONFIG, ...config }, watcher, market, now: () => 1_000 });
}

test('snapshot survives JSON round-trip unchanged (IPC-safe)', () => {
  const s = setup({ clip: { ageMs: Infinity, capturedAt: null } }).snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.clipboard.ageMs, null);
  assert.equal(s.clipboard.ageLevel, 'bad');
});

test('ready light and plan come from the gate with inferred direction', () => {
  const s = setup().snapshot();
  assert.equal(s.ready.level, 'green');
  assert.equal(s.ready.direction, 'long');
  assert.equal(s.plan.sizeStr, '0.04054'); // 9 / 222
  assert.equal(s.plan.riskUsd <= 9, true);
});

test('fixed equity is labelled and shown alongside live equity', () => {
  const s = setup().snapshot();
  assert.equal(s.account.equity, 900);
  assert.equal(s.account.equityLabel, 'fixed (config)');
  assert.equal(s.account.liveEquity, 908.09);
});

test('clipboard age levels', () => {
  assert.equal(setup({ clip: { ageMs: 10_000 } }).snapshot().clipboard.ageLevel, 'ok');
  assert.equal(setup({ clip: { ageMs: 61_000 } }).snapshot().clipboard.ageLevel, 'warn');
  assert.equal(setup({ clip: { ageMs: 91_000 } }).snapshot().clipboard.ageLevel, 'bad');
});

test('setup label only accepts configured labels', () => {
  const store = setup();
  store.setSetupLabel('B');
  assert.equal(store.snapshot().setupLabel, 'B');
  store.setSetupLabel('nonsense');
  assert.equal(store.snapshot().setupLabel, 'B');
});

test('last action carries its age', () => {
  const store = setup();
  store.setLastAction('refused', 'stop too tight');
  assert.deepEqual(store.snapshot().lastAction, { at: 1_000, kind: 'refused', text: 'stop too tight', ageMs: 0 });
});

test('leverage flag and position stop pass through', () => {
  const position = { size: 0.045, entryPx: 83_500, unrealizedPnl: 2, liquidationPx: 80_400, marginUsed: 188, stop: { oid: 1, triggerPx: 83_298, coversSize: true } };
  const s = setup({ account: { leverage: { type: 'isolated', value: 10 }, position } }).snapshot();
  assert.equal(s.account.leverageOk, false);
  assert.equal(s.account.position.stop.triggerPx, 83_298);
  assert.equal(s.ready.level, 'red');
});

test('plan carries the fee estimate; rate flagged as assumed when unknown', () => {
  const s = setup().snapshot();
  assert.ok(s.plan.feesUsd > 3 && s.plan.feesUsd < 3.1); // 0.04054 BTC × (83,520 + 83,298) × 0.045%
  assert.ok(s.plan.feesR > 0.33 && s.plan.feesR < 0.35);
  assert.equal(s.plan.feeRateAssumed, true);
});
