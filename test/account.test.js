import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAccount, leverageMismatch } from '../src/main/account.js';

const summary = { accountValue: '1000.5', totalNtlPos: '0', totalRawUsd: '1000.5', totalMarginUsed: '0' };

const SPEC = { symbol: 'BTC', collateralToken: 0 };

function raw({ positions = [], orders = [], leverage = { type: 'isolated', value: 20, rawUsd: '0' }, abstraction = 'disabled', spotUsdc = '908.09' } = {}) {
  return {
    spec: SPEC,
    abstraction,
    spot: { balances: [
      { coin: 'USDC', token: 0, total: spotUsdc, hold: '0.0', entryNtl: '0.0' },
      { coin: 'USDT0', token: 268, total: '50', hold: '0.0', entryNtl: '0.0' },
    ] },
    clearinghouse: {
      marginSummary: summary,
      crossMarginSummary: summary,
      crossMaintenanceMarginUsed: '0',
      withdrawable: '800',
      assetPositions: positions,
      time: 0,
    },
    orders,
    assetData: { user: '0x', coin: 'BTC', leverage, maxTradeSzs: ['0.2', '0.2'], availableToTrade: ['950', '940'], markPx: '83520' },
  };
}

const position = (coin, szi) => ({
  type: 'oneWay',
  position: {
    coin, szi, entryPx: '83520', positionValue: '3758', unrealizedPnl: '-1.2', returnOnEquity: '0',
    liquidationPx: '80500', marginUsed: '188', maxLeverage: 40,
    leverage: { type: 'isolated', value: 20, rawUsd: '-3570' },
    cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
  },
});

const order = (coin, extra = {}) => ({
  coin, side: 'A', limitPx: '82000', sz: '0.045', oid: 1, timestamp: 0, origSz: '0.045',
  triggerCondition: 'Price below 83298', isTrigger: true, triggerPx: '83298', children: [],
  isPositionTpsl: false, reduceOnly: true, orderType: 'Stop Market', tif: null, cloid: null, ...extra,
});

test('returns null until every source has arrived', () => {
  assert.equal(deriveAccount({ ...raw(), orders: null }), null);
  assert.equal(deriveAccount({ ...raw(), spot: null }), null);
  assert.equal(deriveAccount({ ...raw(), abstraction: null }), null);
});

test('classic account: equity is the perp account value', () => {
  const a = deriveAccount(raw());
  assert.equal(a.equity, 1000.5);
  assert.equal(a.equityBasis, 'perp account value');
  assert.equal(a.position, null);
  assert.deepEqual(a.orders, []);
  assert.deepEqual(a.availableToTrade, { buy: 950, sell: 940 });
});

test('unified account: equity is the spot USDC balance only', () => {
  const a = deriveAccount(raw({ abstraction: 'unifiedAccount' }));
  assert.equal(a.equity, 908.09);
  assert.equal(a.equityBasis, 'unified (spot USDC)');
});

test('unified account with no USDC balance reads zero', () => {
  const r = raw({ abstraction: 'unifiedAccount' });
  r.spot.balances = [];
  assert.equal(deriveAccount(r).equity, 0);
});

test('picks the BTC position and BTC orders only', () => {
  const a = deriveAccount(raw({
    positions: [position('ETH', '1.5'), position('BTC', '-0.045')],
    orders: [order('ETH'), order('BTC', { oid: 7 })],
  }));
  assert.equal(a.position.size, -0.045);
  assert.equal(a.position.liquidationPx, 80500);
  assert.deepEqual(a.orders.map((o) => o.oid), [7]);
  assert.equal(a.orders[0].triggerPx, 83298);
});

test('detects the stop protecting a long', () => {
  const a = deriveAccount(raw({ positions: [position('BTC', '0.045')], orders: [order('BTC', { oid: 9 })] }));
  assert.deepEqual(a.position.stop, { oid: 9, triggerPx: 83298, coversSize: true });
});

test('a stop on the wrong side or not reduce-only does not count', () => {
  const short = deriveAccount(raw({ positions: [position('BTC', '-0.045')], orders: [order('BTC')] })); // sell stop vs short
  assert.equal(short.position.stop, null);
  const notReduce = deriveAccount(raw({ positions: [position('BTC', '0.045')], orders: [order('BTC', { reduceOnly: false })] }));
  assert.equal(notReduce.position.stop, null);
  const tp = deriveAccount(raw({ positions: [position('BTC', '0.045')], orders: [order('BTC', { orderType: 'Take Profit Market' })] }));
  assert.equal(tp.position.stop, null);
});

test('a partial stop is flagged; a position-TPSL stop covers everything', () => {
  const partial = deriveAccount(raw({ positions: [position('BTC', '0.045')], orders: [order('BTC', { sz: '0.02' })] }));
  assert.equal(partial.position.stop.coversSize, false);
  const full = deriveAccount(raw({ positions: [position('BTC', '0.045')], orders: [order('BTC', { sz: '0.0', isPositionTpsl: true })] }));
  assert.equal(full.position.stop.coversSize, true);
});

test('zero-size entries count as flat', () => {
  assert.equal(deriveAccount(raw({ positions: [position('BTC', '0.0')] })).position, null);
});

test('leverage must be isolated at the configured value', () => {
  assert.equal(leverageMismatch(deriveAccount(raw()), 20), null);
  assert.match(leverageMismatch(deriveAccount(raw()), 25), /expected isolated 25x/);
  assert.match(leverageMismatch(deriveAccount(raw({ leverage: { type: 'cross', value: 20 } })), 20), /cross/);
  assert.match(leverageMismatch(null, 20), /not loaded/);
});
