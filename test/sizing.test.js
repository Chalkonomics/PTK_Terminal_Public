import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, floorToLot, liquidationPrice, roundPrice } from '../src/main/sizing.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const CONFIG = { ...DEFAULTS };

const close = (actual, expected, tol = 1e-9) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} ≉ ${expected}`);

test('floorToLot rounds down to the lot size', () => {
  assert.deepEqual(floorToLot(0.045045045, 5), { size: 0.04504, str: '0.04504' });
  assert.deepEqual(floorToLot(0.000019, 5), { size: 0.00001, str: '0.00001' });
  assert.deepEqual(floorToLot(0.000009, 5), { size: 0, str: '0.00000' });
  assert.deepEqual(floorToLot(0, 5), { size: 0, str: '0' });
});

test('floorToLot does not lose an exact unit to float error', () => {
  // 0.29 * 100 = 28.999999999999996 in floating point
  assert.deepEqual(floorToLot(0.29, 2), { size: 0.29, str: '0.29' });
  assert.deepEqual(floorToLot(0.07, 5), { size: 0.07, str: '0.07000' });
});

test('floorToLot never rounds up (risk can only be at or under budget)', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20_000; i++) {
    const raw = rand() * 2;
    const { size } = floorToLot(raw, 5);
    assert.ok(size <= raw, `${size} > ${raw}`);
    assert.ok(raw - size < 0.00001 + 1e-12, `${raw} - ${size} exceeds one lot`);
  }
});

test('roundPrice follows 5 significant figures and max decimals', () => {
  assert.deepEqual(roundPrice(83298.7, SPEC), { px: 83299, str: '83299' });
  assert.deepEqual(roundPrice(83298.7, SPEC, 'down'), { px: 83298, str: '83298' });
  assert.deepEqual(roundPrice(83298.2, SPEC, 'up'), { px: 83299, str: '83299' });
  assert.deepEqual(roundPrice(9123.45, SPEC), { px: 9123.5, str: '9123.5' });
  assert.deepEqual(roundPrice(123456.7, SPEC), { px: 123457, str: '123457' }); // integers exempt from sig-fig cap
  assert.deepEqual(roundPrice(84000, SPEC, 'up'), { px: 84000, str: '84000' }); // exact values don't move
});

test('liquidation at 20x isolated with 1.25% maintenance is ~3.8% (long) / ~3.7% (short)', () => {
  const long = liquidationPrice({ entryPx: 100_000, direction: 'long', leverage: 20, mmr: 0.0125 });
  const short = liquidationPrice({ entryPx: 100_000, direction: 'short', leverage: 20, mmr: 0.0125 });
  close(long, 100_000 * (1 - 0.0375 / 0.9875), 1e-6);
  close(short, 100_000 * (1 + 0.0375 / 1.0125), 1e-6);
  assert.ok(long > 96_000 && long < 96_300);
  assert.ok(short > 103_600 && short < 103_800);
});

test('spec worked example: 1,000 USDC, mark 83,520, long stop 83,298', () => {
  const p = computePlan({ direction: 'long', mark: 83_520, stop: 83_298, equity: 1000, config: CONFIG, spec: SPEC });
  assert.equal(p.stopDistance, 222);
  close(p.intendedSize, 10 / 222);
  assert.equal(p.sizeStr, '0.04504');
  close(p.notional, 0.04504 * 83_520, 1e-6); // ≈ 3,761.74
  assert.equal(p.entryLimitPx, 83_562); // 83,520 × 1.0005 = 83,561.76, rounded up for a buy
  close(p.margin, (0.04504 * 83_562) / 20, 1e-6); // ≈ 188.2
  close(p.riskUsd, 0.04504 * 222, 1e-9);
  assert.ok(p.riskPct <= 0.01 && p.riskPct > 0.0099);
  assert.ok(p.stopLimitPx < p.stopPx);
});

test('short plan mirrors the long', () => {
  const p = computePlan({ direction: 'short', mark: 83_520, stop: 83_742, equity: 1000, config: CONFIG, spec: SPEC });
  assert.equal(p.stopDistance, 222);
  assert.equal(p.sizeStr, '0.04504');
  assert.equal(p.entryLimitPx, 83_478); // 83,520 × 0.9995 = 83,478.24, rounded down for a sell
  assert.ok(p.stopLimitPx > p.stopPx);
  assert.ok(p.liqPx > p.stopPx);
});

test('size is computed from the rounded stop, not the raw value', () => {
  const p = computePlan({ direction: 'long', mark: 83_520, stop: 83_298.6, equity: 1000, config: CONFIG, spec: SPEC });
  assert.equal(p.stopPx, 83_299);
  assert.equal(p.stopDistance, 221);
  assert.ok(p.riskUsd <= 10);
});

test('market entry type uses the wider slippage bound', () => {
  const p = computePlan({ direction: 'long', mark: 80_000, stop: 79_800, equity: 1000, config: { ...CONFIG, entryOrderType: 'market' }, spec: SPEC });
  assert.equal(p.entryLimitPx, 80_400); // 50bp
});

test('no plan without usable inputs', () => {
  const base = { direction: 'long', mark: 83_520, stop: 83_298, equity: 1000, config: CONFIG, spec: SPEC };
  assert.equal(computePlan({ ...base, mark: null }), null);
  assert.equal(computePlan({ ...base, stop: null }), null);
  assert.equal(computePlan({ ...base, equity: 0 }), null);
  assert.equal(computePlan({ ...base, spec: null }), null);
  assert.equal(computePlan({ ...base, stop: 83_520 }), null);
});

test('round-trip fee estimate in USD and R', () => {
  const p = computePlan({ direction: 'long', mark: 83_520, stop: 83_298, equity: 1000, config: CONFIG, spec: SPEC, takerFeeRate: 0.00045 });
  close(p.feesUsd, 0.04504 * (83_520 + 83_298) * 0.00045, 1e-9); // ≈ 3.38
  close(p.feesR, p.feesUsd / p.riskUsd, 1e-12); // ≈ 0.34R
  assert.ok(p.feesR > 0.33 && p.feesR < 0.35);
});

test('tighter stops cost proportionally more R in fees', () => {
  const plan = (stop) => computePlan({ direction: 'long', mark: 85_500, stop, equity: 1000, config: CONFIG, spec: SPEC, takerFeeRate: 0.00045 });
  const tight = plan(85_420); // 80 points
  const wide = plan(85_200); // 300 points
  assert.ok(tight.feesR > 0.9 && tight.feesR < 1.0, `80-point stop: ${tight.feesR}`);
  assert.ok(wide.feesR > 0.25 && wide.feesR < 0.27, `300-point stop: ${wide.feesR}`);
});

test('fee rate defaults to the base taker rate', () => {
  const p = computePlan({ direction: 'long', mark: 83_520, stop: 83_298, equity: 1000, config: CONFIG, spec: SPEC });
  assert.equal(p.takerFeeRate, 0.00045);
});
