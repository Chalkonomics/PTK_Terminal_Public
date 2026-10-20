import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildTradeRow, COLUMNS, createJournal, csvField, csvLine, newTradeRecord, summariseFills } from '../src/main/journal.js';
import { computePlan } from '../src/main/sizing.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const STOP_OID = 777;
// Build paths exactly as the journal does (backslashes on Windows).
const P = (file) => path.join('C:/j', file);
const CONFIG = { ...DEFAULTS, mode: 'testnet', logPath: 'C:/j/trades.csv' };

const fill = (dir, sz, px, { oid = 1, fee, closedPnl = '0', time = 1_000_000, coin = 'BTC', extra = {} } = {}) => ({
  coin, px: String(px), sz: String(sz), side: dir.includes('Long') === dir.startsWith('Open') ? 'B' : 'A', time, startPosition: '0',
  dir, closedPnl: String(closedPnl), hash: '0x', oid, crossed: true, fee: String(fee ?? (sz * px * 0.00045).toFixed(6)), tid: 1, feeToken: 'USDC', twapId: null, ...extra,
});

// A long: entry 0.03333 @ 85,513, stopped at 85,204.
const LONG_FILLS = [
  fill('Open Long', 0.03333, 85_513, { oid: 1, time: 1_000_000 }),
  fill('Close Long', 0.03333, 85_204, { oid: STOP_OID, closedPnl: ((85_204 - 85_513) * 0.03333).toFixed(6), time: 1_060_000 }),
];

function record(over = {}) {
  return {
    tradeId: '0xabc', tsEntry: 1_000_000, coin: 'BTC', mode: 'testnet', setupLabel: 'Break, retest', direction: 'long',
    markAtPress: 85_504, stopPrice: 85_204, stopDistance: 300, stopDistancePct: 300 / 85_504, clipboardAgeMs: 4200,
    intendedSize: 0.03333, plannedRiskUsd: 9.999, equityAtEntry: 1000, leverage: 20, entryOrderType: 'marketableLimit',
    outcome: 'protected', stopOids: [STOP_OID], panic: false, autoFlatten: false, extremes: { min: 85_190, max: 85_600 }, ...over,
  };
}

// ---- CSV ----

test('csv escaping', () => {
  assert.equal(csvField('Break, retest'), '"Break, retest"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField(null), '');
  assert.equal(csvField(NaN), '');
  assert.equal(csvField(-1.25), '-1.25');
  assert.equal(csvLine({}).split(',').length, COLUMNS.length);
});

// ---- fills -> row ----

test('stopped long: net P&L, R, fees, slippage, MAE/MFE', () => {
  const row = buildTradeRow(record(), LONG_FILLS);
  const fees = 0.03333 * 85_513 * 0.00045 + 0.03333 * 85_204 * 0.00045;
  const gross = (85_204 - 85_513) * 0.03333;
  assert.equal(row.exitReason, 'stopped');
  assert.equal(row.entryPrice, 85_513);
  assert.equal(row.exitPrice, 85_204);
  assert.equal(row.filledSize, 0.03333);
  assert.ok(Math.abs(row.feesUsd - fees) < 1e-3);
  assert.ok(Math.abs(row.pnlUsd - (gross - fees)) < 1e-3, `${row.pnlUsd}`);
  assert.ok(Math.abs(row.pnlR - (gross - fees) / 9.999) < 1e-3);
  assert.ok(row.pnlR < -1.25 && row.pnlR > -1.3, 'a stop-out costs more than 1R once fees are included');
  assert.equal(row.slippageBps, 1.05); // (85,513 - 85,504) / 85,504
  assert.equal(row.maeUsd, Number((323 * 0.03333).toFixed(4))); // 85,513 - 85,190
  assert.equal(row.mfeUsd, Number((87 * 0.03333).toFixed(4))); // 85,600 - 85,513
  assert.ok(row.maeR > 1.07 && row.maeR < 1.08);
  assert.equal(row.riskUsd, Number((0.03333 * 309).toFixed(4))); // actual: entry slipped 9 past mark
  assert.equal(row.tsEntry, new Date(1_000_000).toISOString());
  assert.equal(row.tsExit, new Date(1_060_000).toISOString());
});

test('exit reasons', () => {
  const manualFills = [LONG_FILLS[0], { ...LONG_FILLS[1], oid: 999, px: '85300' }];
  assert.equal(buildTradeRow(record(), manualFills).exitReason, 'manual');
  assert.equal(buildTradeRow(record({ panic: true }), manualFills).exitReason, 'panic');
  assert.equal(buildTradeRow(record({ autoFlatten: true }), manualFills).exitReason, 'autoFlatten');
  const liq = [LONG_FILLS[0], { ...LONG_FILLS[1], liquidation: { markPx: '81000', method: 'market' } }];
  assert.equal(buildTradeRow(record(), liq).exitReason, 'liquidated');
});

test('short trade: signs of slippage and excursions flip', () => {
  const fills = [
    fill('Open Short', 0.02, 85_490, { oid: 1 }),
    fill('Close Short', 0.02, 85_300, { oid: 5, closedPnl: (190 * 0.02).toFixed(6), time: 1_100_000 }),
  ];
  const row = buildTradeRow(record({ direction: 'short', markAtPress: 85_504, stopPrice: 85_804, extremes: { min: 85_280, max: 85_560 } }), fills);
  assert.equal(row.exitReason, 'manual');
  assert.equal(row.slippageBps, 1.64, 'sold 14 below the mark: a worse fill for a short, so positive');
  assert.equal(row.maeUsd, Number((70 * 0.02).toFixed(4))); // max 85,560 - entry 85,490
  assert.equal(row.mfeUsd, Number((210 * 0.02).toFixed(4))); // entry 85,490 - min 85,280
  assert.ok(row.pnlUsd > 0);
});

test('not closed yet (partial close or lagging fills): no row', () => {
  assert.equal(buildTradeRow(record(), [LONG_FILLS[0]]), null);
  assert.equal(buildTradeRow(record(), [LONG_FILLS[0], fill('Close Long', 0.01, 85_300, { oid: 9 })]), null);
});

test('other coins and partial fills are summed correctly', () => {
  const s = summariseFills([
    fill('Open Long', 0.01, 85_500), fill('Open Long', 0.02, 85_530), fill('Open Long', 5, 3000, { coin: 'ETH' }),
  ], 'BTC');
  assert.equal(s.entry.size, 0.03);
  assert.ok(Math.abs(s.entry.price - (0.01 * 85_500 + 0.02 * 85_530) / 0.03) < 1e-9);
});

test('trade record captures the plan', () => {
  const plan = computePlan({ direction: 'long', mark: 83_520, stop: 83_298, equity: 1000, config: DEFAULTS, spec: SPEC });
  const r = newTradeRecord({ tradeId: '0x1', tsEntry: 5, plan, markAtPress: 83_519, clipboardAgeMs: 4321.7, setupLabel: 'A', config: CONFIG, outcome: 'protectedOnRetry', stopOid: 42, coin: 'BTC' });
  assert.equal(r.intendedSize, 0.04504);
  assert.equal(r.plannedRiskUsd, plan.riskUsd);
  assert.equal(r.clipboardAgeMs, 4322);
  assert.deepEqual(r.stopOids, [42]);
  assert.equal(r.autoFlatten, false);
  assert.equal(newTradeRecord({ tradeId: '0x1', tsEntry: 5, plan, markAtPress: 1, clipboardAgeMs: 1, setupLabel: 'A', config: CONFIG, outcome: 'flattened', coin: 'BTC' }).autoFlatten, true);
});

// ---- journal lifecycle (in-memory fs) ----

function memFs() {
  const files = new Map();
  const state = { locked: false };
  const fs = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, d) => files.set(p, String(d)),
    unlinkSync: (p) => files.delete(p),
    statSync: (p) => ({ size: (files.get(p) ?? '').length }),
    appendFileSync: (p, d) => {
      if (state.locked && p.endsWith('.csv')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      files.set(p, (files.get(p) ?? '') + d);
    },
  };
  return { fs, files, state };
}

function journalWith({ fills = LONG_FILLS, snapshot, mem = memFs(), time = { now: 1_000_000 } } = {}) {
  let snap = snapshot ?? { mark: 85_520, account: { position: { size: 0.03333, stop: { oid: STOP_OID } } } };
  const j = createJournal({
    config: CONFIG, rootDir: 'C:/j', marketSnapshot: () => snap, fetchFills: async () => fills, log: () => {}, now: () => time.now, fs: mem.fs,
  });
  return { j, mem, time, setSnap: (s) => (snap = s) };
}

const settle = () => new Promise((r) => setImmediate(r));
const csvRows = (mem) => (mem.files.get('C:/j/trades.csv') ?? '').trim().split('\r\n');
const plan = computePlan({ direction: 'long', mark: 85_504, stop: 85_204, equity: 1000, config: DEFAULTS, spec: SPEC });
const ctx = { tradeId: '0xabc', tsEntry: 1_000_000, plan, markAtPress: 85_504, clipboardAgeMs: 3000, setupLabel: 'A', outcome: 'protected', stopOid: STOP_OID };

test('dry-run rows: header written once', () => {
  const { j, mem } = journalWith();
  j.recordDryRun({ tradeId: '0x1', ts: 0, plan, markAtPress: 85_504, clipboardAgeMs: 2000, setupLabel: 'A' });
  j.recordDryRun({ tradeId: '0x2', ts: 1, plan, markAtPress: 85_504, clipboardAgeMs: 2000, setupLabel: 'B' });
  const rows = csvRows(mem);
  assert.equal(rows[0], COLUMNS.join(','));
  assert.equal(rows.length, 3);
  assert.match(rows[1], /^0x1,.*,dryRun,/);
});

test('a locked CSV queues rows and writes them once unlocked', () => {
  const { j, mem } = journalWith();
  mem.state.locked = true;
  j.recordDryRun({ tradeId: '0x1', ts: 0, plan, markAtPress: 85_504, clipboardAgeMs: 2000, setupLabel: 'A' });
  assert.equal(j.status().pending, 1);
  assert.match(j.status().error, /locked \(open in Excel\?\)/);
  assert.ok(mem.files.has(P('journal-pending.jsonl')), 'queue persisted to disk');
  mem.state.locked = false;
  j.tick();
  assert.equal(j.status().pending, 0);
  assert.equal(j.status().error, null);
  assert.equal(csvRows(mem).length, 2);
  assert.ok(!mem.files.has(P('journal-pending.jsonl')));
});

test('open trade: samples extremes, finalises when flat, writes one row', async () => {
  const { j, mem, setSnap, time } = journalWith();
  j.openTrade(ctx);
  assert.ok(mem.files.has(P('open-trade.json')));
  for (const mark of [85_520, 85_190, 85_600, 85_400]) {
    setSnap({ mark, account: { position: { size: 0.03333, stop: { oid: STOP_OID } } } });
    j.tick();
  }
  assert.deepEqual(JSON.parse(mem.files.get(P('open-trade.json'))).extremes, { min: 85_190, max: 85_600 });
  setSnap({ mark: 85_204, account: { position: null } });
  time.now += 60_000;
  j.tick();
  await settle();
  const rows = csvRows(mem);
  assert.equal(rows.length, 2);
  const row = Object.fromEntries(COLUMNS.map((c, i) => [c, rows[1].split(',')[i]]));
  assert.equal(row.exitReason, 'stopped');
  assert.equal(row.maeUsd, String(Number((323 * 0.03333).toFixed(4))));
  assert.ok(!mem.files.has(P('open-trade.json')), 'open-trade.json removed once written');
  assert.equal(j.status().open, null);
});

test('waits while closing fills lag, then completes', async () => {
  const mem = memFs();
  let fills = [LONG_FILLS[0]];
  const time = { now: 1_000_000 };
  const j = createJournal({ config: CONFIG, rootDir: 'C:/j', marketSnapshot: () => ({ mark: 85_204, account: { position: null } }), fetchFills: async () => fills, log: () => {}, now: () => time.now, fs: mem.fs });
  j.openTrade(ctx);
  j.tick();
  await settle();
  assert.equal(csvRows(mem)[0], '', 'nothing written yet');
  fills = LONG_FILLS;
  time.now += 1000;
  j.tick(); // throttled: under 5s since the last attempt
  await settle();
  assert.ok(!mem.files.has('C:/j/trades.csv'));
  time.now += 5000;
  j.tick();
  await settle();
  assert.equal(csvRows(mem).length, 2);
});

test('panic flag survives into the row', async () => {
  const { j, mem, setSnap, time } = journalWith({ fills: [LONG_FILLS[0], { ...LONG_FILLS[1], oid: 1234 }] });
  j.openTrade(ctx);
  j.markPanic();
  setSnap({ mark: 85_204, account: { position: null } });
  time.now += 10_000;
  j.tick();
  await settle();
  assert.match(csvRows(mem)[1], /,panic,/);
});

test('an open trade is resumed after a restart', () => {
  const mem = memFs();
  mem.files.set(P('open-trade.json'), JSON.stringify(record()));
  const { j } = journalWith({ mem });
  assert.deepEqual(j.status().open, { tradeId: '0xabc', direction: 'long' });
});

test('a record with no fills a minute later is discarded (no trade happened)', async () => {
  const { j, mem, setSnap, time } = journalWith({ fills: [] });
  j.openTrade(ctx);
  setSnap({ mark: 85_504, account: { position: null } });
  time.now += 61_000;
  j.tick();
  await settle();
  assert.equal(j.status().open, null);
  assert.ok(!mem.files.has('C:/j/trades.csv'));
});

test('stop-out is recognised by price even if the fill carries a different order id', () => {
  const fills = [LONG_FILLS[0], { ...LONG_FILLS[1], oid: 4242, px: '85190' }]; // filled 14 beyond the stop
  assert.equal(buildTradeRow(record({ stopOids: [] }), fills).exitReason, 'stopped');
  const above = [LONG_FILLS[0], { ...LONG_FILLS[1], oid: 4242, px: '85300' }];
  assert.equal(buildTradeRow(record({ stopOids: [] }), above).exitReason, 'manual');
});
