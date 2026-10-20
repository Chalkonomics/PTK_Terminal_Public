import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceMarginRate, parseMarketSpec } from '../src/main/marketSpec.js';

// Shape observed from mainnet meta on 2026-10-03.
const META = {
  universe: [
    { szDecimals: 5, name: 'BTC', maxLeverage: 40, marginTableId: 56 },
    { szDecimals: 4, name: 'ETH', maxLeverage: 25, marginTableId: 25 },
    { szDecimals: 2, name: 'OLD', maxLeverage: 3, marginTableId: 3, isDelisted: true },
  ],
  marginTables: [
    [56, { description: 'tiered 40x', marginTiers: [
      { lowerBound: '150000000.0', maxLeverage: 20 },
      { lowerBound: '0.0', maxLeverage: 40 },
    ] }],
  ],
  collateralToken: 0,
};

test('parses BTC rules from meta', () => {
  const spec = parseMarketSpec(META, 'BTC');
  assert.equal(spec.assetId, 0);
  assert.equal(spec.szDecimals, 5);
  assert.equal(spec.lotSize, 0.00001);
  assert.equal(spec.priceMaxDecimals, 1);
  assert.equal(spec.maxLeverage, 40);
  assert.deepEqual(spec.marginTiers, [
    { lowerBound: 0, maxLeverage: 40 },
    { lowerBound: 150_000_000, maxLeverage: 20 },
  ]);
});

test('falls back to a single tier when the table is implicit', () => {
  const spec = parseMarketSpec(META, 'ETH');
  assert.equal(spec.assetId, 1);
  assert.deepEqual(spec.marginTiers, [{ lowerBound: 0, maxLeverage: 25 }]);
});

test('rejects unknown and delisted symbols', () => {
  assert.throws(() => parseMarketSpec(META, 'DOGE'), /not found/);
  assert.throws(() => parseMarketSpec(META, 'OLD'), /delisted/);
});

test('maintenance margin is half the initial margin at the tier max leverage', () => {
  const spec = parseMarketSpec(META, 'BTC');
  assert.equal(maintenanceMarginRate(spec, 4_000), 0.0125);
  assert.equal(maintenanceMarginRate(spec, 200_000_000), 0.025);
});
