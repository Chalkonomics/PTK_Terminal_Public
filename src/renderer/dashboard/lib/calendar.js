// Calendar and stats logic for the trades dashboard. Pure functions, no React,
// so they're tested directly (test/calendar.test.js).
//
// Days are 'YYYY-MM-DD' keys in the PC's local time zone. Notion dates are UTC
// instants, so a trade at 00:30 local on the 6th lands on the 6th even though
// it's the 5th in UTC. Day arithmetic is done on the keys (in UTC), so daylight
// saving changes can't shift a day.

export const BE_BAND_R = 0.1; // same scratch band as the Notion sync's Trade Outcome

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parse = (key) => key.split('-').map(Number);
const utc = (key) => {
  const [y, m, d] = parse(key);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (date) => keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

/** The local day of an instant, as 'YYYY-MM-DD'. `timeZone` is for tests; the PC's zone by default. */
export function dayKey(instant, timeZone) {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

export function addDays(key, n) {
  const date = utc(key);
  date.setUTCDate(date.getUTCDate() + n);
  return fromUtc(date);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(key) {
  return (utc(key).getUTCDay() + 6) % 7;
}

export function startOfWeek(key) {
  return addDays(key, -weekday(key));
}

export function monthOf(key) {
  const [y, m] = parse(key);
  return { year: y, month: m };
}

export function addMonths({ year, month }, n) {
  const index = year * 12 + (month - 1) + n;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function firstOfMonth({ year, month }) {
  return keyOf(year, month, 1);
}

/** Monday-start weeks covering the month: each week is 7 day keys, spilling into the months either side. */
export function monthGrid({ year, month }) {
  const first = firstOfMonth({ year, month });
  const last = addDays(firstOfMonth(addMonths({ year, month }, 1)), -1);
  const weeks = [];
  for (let start = startOfWeek(first); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

/** Local midnight at the start of `key`, as an ISO instant for the Notion query. */
export function dayStart(key) {
  const [y, m, d] = parse(key);
  return new Date(y, m - 1, d).toISOString();
}

export const PERIODS = [
  { id: 'thisMonth', label: 'This Month' },
  { id: 'lastMonth', label: 'Last Month' },
  { id: 'lastQuarter', label: 'Last Quarter' },
  { id: 'lastYear', label: 'Last Year' },
  { id: 'all', label: 'All' },
];

/**
 * Calendar periods as day keys, `to` exclusive. 'all' is unbounded (nulls).
 * Last Quarter / Last Year are the previous calendar quarter / year.
 */
export function periodDays(id, today) {
  const { year, month } = monthOf(today);
  const thisMonth = { year, month };
  switch (id) {
    case 'thisMonth':
      return { from: firstOfMonth(thisMonth), to: firstOfMonth(addMonths(thisMonth, 1)) };
    case 'lastMonth':
      return { from: firstOfMonth(addMonths(thisMonth, -1)), to: firstOfMonth(thisMonth) };
    case 'lastQuarter': {
      const quarterStart = { year, month: month - ((month - 1) % 3) };
      return { from: firstOfMonth(addMonths(quarterStart, -3)), to: firstOfMonth(quarterStart) };
    }
    case 'lastYear':
      return { from: keyOf(year - 1, 1, 1), to: keyOf(year, 1, 1) };
    case 'all':
      return { from: null, to: null };
    default:
      throw new Error(`unknown period ${id}`);
  }
}

// --- Values ---

/**
 * The figure shown for a trade: R or $, gross (fees ignored) or net (fees taken off).
 * @param {{ unit: 'R' | '$', fees: 'gross' | 'net' }} view
 */
export function shownValue(trade, { unit, fees }) {
  if (unit === 'R') return fees === 'net' ? trade.rNet : trade.rGross;
  return fees === 'net' ? trade.pnlNet : trade.pnlGross;
}

/** R for classifying win/loss/BE, following the fees toggle (not the R/$ toggle). */
function classifyingR(trade, fees) {
  return fees === 'net' ? trade.rNet : trade.rGross;
}

/** 'win' | 'loss' | 'be', or null when the R is missing. */
export function classify(trade, fees) {
  const r = classifyingR(trade, fees);
  if (r === null || r === undefined) return null;
  if (Math.abs(r) < BE_BAND_R) return 'be';
  return r > 0 ? 'win' : 'loss';
}

/** 'profit' | 'loss' | 'scratch' for a day or week, from its total R (the same band as a single trade). */
export function tone(rTotal) {
  if (Math.abs(rTotal) < BE_BAND_R) return 'scratch';
  return rTotal > 0 ? 'profit' : 'loss';
}

/** Trades that have the shown figure, and how many were left out for missing it. */
export function usable(trades, view) {
  const kept = trades.filter((t) => Number.isFinite(shownValue(t, view)));
  return { kept, missing: trades.length - kept.length };
}

/** Totals for any group of trades (a day, a week, a period). Trades without the shown figure are skipped. */
export function summarize(trades, view) {
  const { kept, missing } = usable(trades, view);
  let total = 0;
  let rTotal = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  for (const t of kept) {
    total += shownValue(t, view);
    rTotal += classifyingR(t, view.fees) ?? 0;
    const c = classify(t, view.fees);
    if (c === 'win') wins += 1;
    else if (c === 'loss') losses += 1;
    else if (c === 'be') scratches += 1;
  }
  const decided = wins + losses;
  return {
    total,
    rTotal,
    count: kept.length,
    wins,
    losses,
    scratches,
    winPct: decided ? (wins / decided) * 100 : null, // BE trades count for neither side
    missing,
    tone: tone(rTotal),
  };
}

/** Trades grouped by local day: Map of day key → trades (oldest first). */
export function groupByDay(trades, timeZone) {
  const days = new Map();
  for (const t of [...trades].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const key = dayKey(t.date, timeZone);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(t);
  }
  return days;
}

/** Consecutive trading days with a positive total, counting back from the latest trading day. Days without trades are skipped. */
export function greenStreak(byDay, view) {
  const keys = [...byDay.keys()].sort().reverse();
  let streak = 0;
  for (const key of keys) {
    const day = summarize(byDay.get(key), view);
    if (!day.count) continue;
    if (day.total > 0) streak += 1;
    else break;
  }
  return streak;
}

/** Running total of the shown figure, oldest first, for the Net card's line. */
export function cumulative(trades, view) {
  let sum = 0;
  return usable(trades, view)
    .kept.sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .map((t) => (sum += shownValue(t, view)));
}

// --- Formatting ---

export function formatValue(value, unit, { sign = true } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const s = sign ? (value > 0 ? '+' : value < 0 ? '−' : '') : value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (unit === 'R') return `${s}${abs.toFixed(2)}R`;
  return `${s}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTime(instant) {
  return new Date(instant).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

export function monthLabel({ year, month }) {
  return `${MONTHS[month - 1]} ${year}`;
}

/** e.g. "6 Oct" */
export function shortDay(key) {
  const [, m, d] = parse(key);
  return `${d} ${SHORT_MONTHS[m - 1]}`;
}

export function dayOfMonth(key) {
  return parse(key)[2];
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
