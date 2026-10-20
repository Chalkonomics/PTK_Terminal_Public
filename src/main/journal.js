import nodeFs from 'node:fs';
import path from 'node:path';

// The trade journal: the reason the tool exists. One row per trade, appended to
// trades.csv when the trade closes. While a trade is open it lives in
// open-trade.json, so tracking survives a restart. Exit details come from the
// exchange's own fill records; P&L and R are net of fees.
//
// Rows that can't be written (Excel locks a CSV while it's open) are queued in
// journal-pending.jsonl and retried every tick, so nothing is lost.

export const COLUMNS = [
  'tradeId', 'tsEntry', 'mode', 'setupLabel', 'direction', 'markAtPress', 'stopPrice', 'stopDistance', 'stopDistancePct',
  'clipboardAgeMs', 'intendedSize', 'filledSize', 'entryPrice', 'slippageBps', 'plannedRiskUsd', 'riskUsd', 'notional',
  'marginUsed', 'equityAtEntry', 'exitReason', 'tsExit', 'exitPrice', 'pnlUsd', 'pnlR', 'feesUsd',
  'maeUsd', 'maeR', 'mfeUsd', 'mfeR', 'entryOrderType', 'outcome',
];

const FINALIZE_INTERVAL_MS = 5000; // userFillsByTime is a heavy request; don't poll it every second
const SIZE_EPSILON = 1e-9;

/** CSV-escapes one value. */
export function csvField(v) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(row) {
  return COLUMNS.map((c) => csvField(row[c])).join(',') + '\r\n';
}

/** Splits a trade's fills into opening and closing legs with VWAPs, fees and gross P&L. */
export function summariseFills(fills, coin) {
  const legs = { open: { size: 0, cost: 0, time: null }, close: { size: 0, cost: 0, time: null, oids: new Set() } };
  let feesUsd = 0;
  let grossPnl = 0;
  let liquidated = false;
  for (const f of fills) {
    if (f.coin !== coin) continue;
    const sz = Number(f.sz);
    const px = Number(f.px);
    const leg = f.dir.startsWith('Open') ? legs.open : f.dir.startsWith('Close') ? legs.close : null;
    if (!leg) continue;
    leg.size += sz;
    leg.cost += sz * px;
    leg.time = Math.max(leg.time ?? 0, f.time);
    if (leg === legs.close) legs.close.oids.add(f.oid);
    if (f.feeToken === 'USDC') feesUsd += Number(f.fee) + Number(f.builderFee ?? 0);
    grossPnl += Number(f.closedPnl);
    if (f.liquidation) liquidated = true;
  }
  const vwap = (leg) => (leg.size > 0 ? leg.cost / leg.size : null);
  return {
    entry: { size: legs.open.size, price: vwap(legs.open), time: legs.open.time },
    exit: { size: legs.close.size, price: vwap(legs.close), time: legs.close.time, oids: legs.close.oids },
    feesUsd,
    grossPnl,
    liquidated,
  };
}

/**
 * Builds the completed row for a closed trade, or null if the fills don't yet
 * show the position fully closed (fills can lag the position update).
 */
export function buildTradeRow(trade, fills) {
  const s = summariseFills(fills, trade.coin);
  if (!(s.entry.size > 0) || s.exit.size < s.entry.size - SIZE_EPSILON) return null;

  const side = trade.direction === 'long' ? 1 : -1;
  const entry = s.entry.price;
  const filled = s.entry.size;
  const pnlUsd = s.grossPnl - s.feesUsd;
  const r = trade.plannedRiskUsd;

  // Excursions from the per-second mark samples, measured from the actual entry.
  const adverse = trade.extremes ? Math.max(0, side === 1 ? entry - trade.extremes.min : trade.extremes.max - entry) : null;
  const favourable = trade.extremes ? Math.max(0, side === 1 ? trade.extremes.max - entry : entry - trade.extremes.min) : null;

  let exitReason = 'manual';
  if (s.liquidated) exitReason = 'liquidated';
  else if (trade.panic) exitReason = 'panic';
  else if (trade.autoFlatten) exitReason = 'autoFlatten';
  else if ([...s.exit.oids].some((oid) => trade.stopOids.includes(oid))) exitReason = 'stopped';
  // Fallback if the triggered fill carries a different order id: a manual close can't
  // fill beyond the stop (the stop would have triggered first), so an exit there was the stop.
  else if (side === 1 ? s.exit.price <= trade.stopPrice : s.exit.price >= trade.stopPrice) exitReason = 'stopped';

  return {
    tradeId: trade.tradeId,
    tsEntry: new Date(trade.tsEntry).toISOString(),
    mode: trade.mode,
    setupLabel: trade.setupLabel,
    direction: trade.direction,
    markAtPress: trade.markAtPress,
    stopPrice: trade.stopPrice,
    stopDistance: trade.stopDistance,
    stopDistancePct: round(trade.stopDistancePct * 100, 4),
    clipboardAgeMs: trade.clipboardAgeMs,
    intendedSize: trade.intendedSize,
    filledSize: round(filled, 8),
    entryPrice: round(entry, 2),
    slippageBps: round(((side * (entry - trade.markAtPress)) / trade.markAtPress) * 10_000, 2),
    plannedRiskUsd: round(r, 4),
    riskUsd: round(filled * Math.abs(entry - trade.stopPrice), 4),
    notional: round(filled * entry, 2),
    marginUsed: round((filled * entry) / trade.leverage, 2),
    equityAtEntry: trade.equityAtEntry,
    exitReason,
    tsExit: new Date(s.exit.time).toISOString(),
    exitPrice: round(s.exit.price, 2),
    pnlUsd: round(pnlUsd, 4),
    pnlR: r > 0 ? round(pnlUsd / r, 4) : null,
    feesUsd: round(s.feesUsd, 4),
    maeUsd: adverse === null ? null : round(adverse * filled, 4),
    maeR: adverse === null || !(r > 0) ? null : round((adverse * filled) / r, 4),
    mfeUsd: favourable === null ? null : round(favourable * filled, 4),
    mfeR: favourable === null || !(r > 0) ? null : round((favourable * filled) / r, 4),
    entryOrderType: trade.entryOrderType,
    outcome: trade.outcome,
  };
}

/** The open-trade record kept while a position is live. */
export function newTradeRecord({ tradeId, tsEntry, plan, markAtPress, clipboardAgeMs, setupLabel, config, outcome, stopOid, coin }) {
  return {
    tradeId,
    tsEntry,
    coin,
    mode: config.mode,
    setupLabel,
    direction: plan.direction,
    markAtPress,
    stopPrice: plan.stopPx,
    stopDistance: plan.stopDistance,
    stopDistancePct: plan.stopDistancePct,
    clipboardAgeMs: Number.isFinite(clipboardAgeMs) ? Math.round(clipboardAgeMs) : null,
    intendedSize: plan.size,
    plannedRiskUsd: plan.riskUsd,
    equityAtEntry: plan.equity,
    leverage: config.leverage,
    entryOrderType: config.entryOrderType,
    outcome,
    stopOids: stopOid ? [stopOid] : [],
    panic: false,
    autoFlatten: outcome === 'flattened' || outcome === 'flattenFailed',
    extremes: null,
  };
}

/** The row for a dry-run press: what would have been sent. No fill or exit. */
export function dryRunRow({ tradeId, ts, plan, markAtPress, clipboardAgeMs, setupLabel, config }) {
  return {
    tradeId,
    tsEntry: new Date(ts).toISOString(),
    mode: 'dryRun',
    setupLabel,
    direction: plan.direction,
    markAtPress,
    stopPrice: plan.stopPx,
    stopDistance: plan.stopDistance,
    stopDistancePct: round(plan.stopDistancePct * 100, 4),
    clipboardAgeMs: Number.isFinite(clipboardAgeMs) ? Math.round(clipboardAgeMs) : null,
    intendedSize: plan.size,
    plannedRiskUsd: round(plan.riskUsd, 4),
    riskUsd: round(plan.riskUsd, 4),
    notional: round(plan.notional, 2),
    marginUsed: round(plan.margin, 2),
    equityAtEntry: plan.equity,
    exitReason: 'dryRun',
    entryOrderType: config.entryOrderType,
    outcome: 'dryRun',
  };
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.rootDir                      where open-trade.json and journal-pending.jsonl live
 * @param {() => object} deps.marketSnapshot         market.snapshot()
 * @param {(startTime: number) => Promise<object[]>} deps.fetchFills
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {typeof nodeFs} [deps.fs]
 * @param {{ tradeOpened, tradeClosed, tradeDiscarded }} [deps.mirror]  e.g. the Notion sync; told about each trade
 */
export function createJournal({ config, rootDir, marketSnapshot, fetchFills, log = console.log, now = Date.now, fs = nodeFs, mirror = null }) {
  const csvPath = config.logPath;
  const openPath = path.join(rootDir, 'open-trade.json');
  const pendingPath = path.join(rootDir, 'journal-pending.jsonl');

  let open = readJson(openPath);
  let pending = readPending();
  let lastError = null;
  let lastFinalizeAttempt = 0;
  let finalizing = false;
  if (open) log(`[journal] resuming open trade ${open.tradeId}`);

  function readJson(p) {
    try {
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  function readPending() {
    try {
      if (!fs.existsSync(pendingPath)) return [];
      return fs.readFileSync(pendingPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  function saveOpen() {
    try {
      if (open) fs.writeFileSync(openPath, JSON.stringify(open, null, 2));
      else if (fs.existsSync(openPath)) fs.unlinkSync(openPath);
    } catch (err) {
      log(`[journal] could not save open trade: ${err.message}`);
    }
  }

  function savePending() {
    try {
      if (pending.length) fs.writeFileSync(pendingPath, pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
      else if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    } catch (err) {
      log(`[journal] could not save pending rows: ${err.message}`);
    }
  }

  /** Appends queued rows to the CSV. Stops at the first failure (file locked) and retries next tick. */
  function flush() {
    if (!pending.length) return;
    try {
      const needsHeader = !fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0;
      fs.appendFileSync(csvPath, (needsHeader ? COLUMNS.join(',') + '\r\n' : '') + pending.map(csvLine).join(''));
      log(`[journal] wrote ${pending.length} row(s) to ${path.basename(csvPath)}`);
      pending = [];
      lastError = null;
    } catch (err) {
      lastError = err.code === 'EBUSY' || err.code === 'EPERM' ? `${path.basename(csvPath)} is locked (open in Excel?)` : err.message;
    }
    savePending();
  }

  /** Passes a trade event on to the mirror. Its failures never reach the journal. */
  function notify(event, value) {
    try {
      mirror?.[event](value);
    } catch (err) {
      log(`[journal] ${event} mirror failed: ${err.message}`);
    }
  }

  function write(row) {
    pending.push(row);
    flush();
  }

  async function finalize() {
    finalizing = true;
    lastFinalizeAttempt = now();
    try {
      const fills = await fetchFills(open.tsEntry - 5000);
      const row = buildTradeRow(open, fills);
      if (!row) {
        // No opening fill a minute after the press means no trade happened (e.g. an
        // unclear submission that never executed). Otherwise closing fills are lagging.
        if (summariseFills(fills, open.coin).entry.size === 0 && now() - open.tsEntry > 60_000) {
          log(`[journal] no fills for ${open.tradeId}; discarding (no trade took place)`);
          notify('tradeDiscarded', open);
          open = null;
          saveOpen();
        }
        return;
      }
      log(`[journal] trade ${open.tradeId} closed: ${row.exitReason}, ${row.pnlUsd} USD (${row.pnlR}R)`);
      open = null;
      saveOpen();
      write(row);
      notify('tradeClosed', row);
    } catch (err) {
      lastError = `could not fetch fills: ${err.message}`;
    } finally {
      finalizing = false;
    }
  }

  return {
    recordDryRun(ctx) {
      write(dryRunRow({ ...ctx, config }));
    },
    /** Starts tracking a trade whose entry filled (any outcome after remediation). */
    openTrade(ctx) {
      open = newTradeRecord({ ...ctx, config, coin: config.symbol });
      saveOpen();
      log(`[journal] tracking trade ${open.tradeId} (${open.outcome})`);
      notify('tradeOpened', open);
    },
    markPanic() {
      if (!open) return;
      open.panic = true;
      saveOpen();
    },
    /** Called every second: samples the mark for MAE/MFE, finalises once flat, retries pending writes. */
    tick() {
      flush();
      if (!open) return;
      const snap = marketSnapshot();
      if (snap.mark > 0 && snap.account?.position) {
        const e = open.extremes;
        let changed = !e || snap.mark < e.min || snap.mark > e.max;
        if (changed) open.extremes = { min: Math.min(e?.min ?? snap.mark, snap.mark), max: Math.max(e?.max ?? snap.mark, snap.mark) };
        // Track the live stop's order id so a stop-out is recognised even after a retry.
        const stopOid = snap.account.position.stop?.oid;
        if (stopOid && !open.stopOids.includes(stopOid)) {
          open.stopOids.push(stopOid);
          changed = true;
        }
        if (changed) saveOpen();
      }
      const flat = snap.account && !snap.account.position;
      if (flat && !finalizing && now() - lastFinalizeAttempt >= FINALIZE_INTERVAL_MS) finalize();
    },
    status() {
      return { open: open && { tradeId: open.tradeId, direction: open.direction }, pending: pending.length, error: lastError, file: path.basename(csvPath) };
    },
    /** Test hook: wait for an in-flight finalisation. */
    get finalizing() {
      return finalizing;
    },
  };
}

const round = (n, dp) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(dp)));
