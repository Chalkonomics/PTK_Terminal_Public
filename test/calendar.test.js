import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, classify, cumulative, dayKey, formatValue, greenStreak, groupByDay, monthGrid, periodDays,
  shownValue, startOfWeek, summarize, tone, weekday,
} from '../src/renderer/dashboard/lib/calendar.js';

const R_GROSS = { unit: 'R', fees: 'gross' };
const R_NET = { unit: 'R', fees: 'net' };
const USD_NET = { unit: '$', fees: 'net' };

const trade = (date, rGross, rNet = rGross, extra = {}) => ({ date, rGross, rNet, pnlGross: rGross * 10, pnlNet: rNet * 10, ...extra });

test('trades land on their local day, not their UTC day', () => {
  // 23:30 UTC on 5 Oct is 00:30 on 6 Oct in London (BST).
  assert.equal(dayKey('2026-10-05T23:30:00.000Z', 'Europe/London'), '2026-10-06');
  assert.equal(dayKey('2026-10-05T23:30:00.000Z', 'UTC'), '2026-10-05');
  // After the clocks go back (25 Oct 2026) London is UTC again.
  assert.equal(dayKey('2026-10-26T23:30:00.000Z', 'Europe/London'), '2026-10-26');
  // Notion may return an offset rather than Z.
  assert.equal(dayKey('2026-10-06T00:30:00.000+01:00', 'Europe/London'), '2026-10-06');
});

test('weeks start on Monday', () => {
  assert.equal(weekday('2026-10-05'), 0, '5 Oct 2026 is a Monday');
  assert.equal(weekday('2026-10-11'), 6, 'Sunday');
  assert.equal(startOfWeek('2026-10-11'), '2026-10-05');
  assert.equal(startOfWeek('2026-10-01'), '2026-09-28');
});

test('day arithmetic crosses months, years and DST without drifting', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-10-24', 2), '2026-10-26', 'across the clocks going back');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29', 'leap year');
});

test('the month grid is whole Monday-to-Sunday weeks covering the month', () => {
  const oct = monthGrid({ year: 2026, month: 10 });
  assert.equal(oct.length, 5);
  assert.deepEqual([oct[0][0], oct[0][6]], ['2026-09-28', '2026-10-04']);
  assert.deepEqual([oct[4][0], oct[4][6]], ['2026-10-26', '2026-11-01']);
  // February 2027 starts on a Monday and ends on a Sunday: exactly 4 weeks.
  const feb = monthGrid({ year: 2027, month: 2 });
  assert.equal(feb.length, 4);
  assert.deepEqual([feb[0][0], feb[3][6]], ['2027-02-01', '2027-02-28']);
});

test('periods are calendar periods with an exclusive end', () => {
  const today = '2026-10-05';
  assert.deepEqual(periodDays('thisMonth', today), { from: '2026-10-01', to: '2026-11-01' });
  assert.deepEqual(periodDays('lastMonth', today), { from: '2026-09-01', to: '2026-10-01' });
  assert.deepEqual(periodDays('lastQuarter', today), { from: '2026-07-01', to: '2026-10-01' });
  assert.deepEqual(periodDays('lastQuarter', '2026-02-15'), { from: '2025-10-01', to: '2026-01-01' });
  assert.deepEqual(periodDays('lastMonth', '2026-01-10'), { from: '2025-12-01', to: '2026-01-01' });
  assert.deepEqual(periodDays('lastYear', today), { from: '2025-01-01', to: '2026-01-01' });
  assert.deepEqual(periodDays('all', today), { from: null, to: null });
});

test('the toggles pick the figure: R or $, gross (fees ignored) or net', () => {
  const t = { rGross: 2, rNet: 1.53, pnlGross: 20, pnlNet: 15.31 };
  assert.equal(shownValue(t, R_GROSS), 2);
  assert.equal(shownValue(t, R_NET), 1.53);
  assert.equal(shownValue(t, { unit: '$', fees: 'gross' }), 20);
  assert.equal(shownValue(t, USD_NET), 15.31);
});

test('win/loss/BE follow the fees toggle, with the Notion sync band', () => {
  const feeEaten = trade('2026-10-05T09:00:00Z', 0.3, -0.6);
  assert.equal(classify(feeEaten, 'gross'), 'win');
  assert.equal(classify(feeEaten, 'net'), 'loss');
  assert.equal(classify(trade('x', 0.09), 'gross'), 'be');
  assert.equal(classify(trade('x', -0.1), 'gross'), 'loss');
  assert.equal(classify({ rGross: null }, 'gross'), null);
});

test('summaries: totals, count, win % without BE, and missing figures', () => {
  const trades = [
    trade('2026-10-05T09:00:00Z', 2, 1.5),
    trade('2026-10-05T10:00:00Z', -1, -1.4),
    trade('2026-10-05T11:00:00Z', 0.05, -0.3),
    trade('2026-10-05T12:00:00Z', null, null),
  ];
  const gross = summarize(trades, R_GROSS);
  assert.equal(gross.count, 3);
  assert.equal(gross.missing, 1);
  assert.ok(Math.abs(gross.total - 1.05) < 1e-9);
  assert.deepEqual([gross.wins, gross.losses, gross.scratches], [1, 1, 1]);
  assert.equal(gross.winPct, 50);
  assert.equal(gross.tone, 'profit');

  const net = summarize(trades, R_NET);
  assert.deepEqual([net.wins, net.losses, net.scratches], [1, 2, 0]);
  assert.ok(Math.abs(net.winPct - 100 / 3) < 1e-9);
  assert.equal(net.tone, 'loss');

  assert.deepEqual(summarize([], R_GROSS).winPct, null);
});

test('day and week tone uses the BE band', () => {
  assert.equal(tone(0.05), 'scratch');
  assert.equal(tone(0.1), 'profit');
  assert.equal(tone(-0.5), 'loss');
});

test('grouping by day sorts trades and splits at local midnight', () => {
  const days = groupByDay([
    trade('2026-10-06T08:00:00Z', 1),
    trade('2026-10-05T23:30:00Z', 2), // 00:30 on the 6th in London
    trade('2026-10-05T22:30:00Z', 3), // 23:30 on the 5th in London
  ], 'Europe/London');
  assert.deepEqual([...days.keys()], ['2026-10-05', '2026-10-06']);
  assert.deepEqual(days.get('2026-10-06').map((t) => t.rGross), [2, 1]);
});

test('green-day streak counts back from the latest trading day; empty days do not break it', () => {
  const days = new Map([
    ['2026-10-01', [trade('2026-10-01T09:00:00Z', -1)]],
    ['2026-10-02', [trade('2026-10-02T09:00:00Z', 1)]],
    ['2026-10-05', [trade('2026-10-05T09:00:00Z', 2), trade('2026-10-05T10:00:00Z', -0.5)]],
    ['2026-10-07', [trade('2026-10-07T09:00:00Z', 0.4)]],
  ]);
  assert.equal(greenStreak(days, R_GROSS), 3);
  days.set('2026-10-08', [trade('2026-10-08T09:00:00Z', -0.2)]);
  assert.equal(greenStreak(days, R_GROSS), 0);
  assert.equal(greenStreak(new Map(), R_GROSS), 0);
});

test('cumulative runs oldest first over trades with the figure', () => {
  const trades = [trade('2026-10-05T10:00:00Z', -1), trade('2026-10-05T09:00:00Z', 2), trade('2026-10-05T11:00:00Z', null)];
  assert.deepEqual(cumulative(trades, R_GROSS), [2, 1]);
});

test('formatting', () => {
  assert.equal(formatValue(1.5312, 'R'), '+1.53R');
  assert.equal(formatValue(-0.5, 'R'), '−0.50R');
  assert.equal(formatValue(4302.21, '$'), '+$4,302.21');
  assert.equal(formatValue(-212, '$'), '−$212.00');
  assert.equal(formatValue(0, 'R'), '0.00R');
  assert.equal(formatValue(null, 'R'), '—');
});
