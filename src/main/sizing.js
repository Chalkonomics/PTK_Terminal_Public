import { maintenanceMarginRate } from './marketSpec.js';

// Pure sizing arithmetic. Size is derived entirely from stop distance:
//   size = equity × riskPct / |mark − stop|
// rounded DOWN to the lot size so actual risk is at or just under the budget.

/** Hyperliquid's minimum order value, USD. */
export const MIN_ORDER_NOTIONAL = 10;
/** Base-tier taker fee, used only when the account's own rate is unavailable. */
export const DEFAULT_TAKER_FEE = 0.00045;

/**
 * Rounds a size down to the market's lot size without ever rounding up.
 * @returns {{ size: number, str: string }}
 */
export function floorToLot(rawSize, szDecimals) {
  if (!(rawSize > 0)) return { size: 0, str: '0' };
  const scale = 10 ** szDecimals;
  let units = Math.floor(rawSize * scale);
  // Float products can land a hair under an exact unit (e.g. 0.29 * 100 = 28.999…).
  if ((units + 1) / scale <= rawSize) units += 1;
  return { size: units / scale, str: (units / scale).toFixed(szDecimals) };
}

/**
 * Rounds a price to Hyperliquid's rules: at most `priceMaxDecimals` decimals and
 * at most 5 significant figures, with integers always allowed.
 * @param {'down' | 'up' | 'nearest'} mode
 * @returns {{ px: number, str: string }}
 */
export function roundPrice(px, spec, mode = 'nearest') {
  const intDigits = Math.max(1, Math.floor(Math.log10(Math.abs(px))) + 1);
  const decimals = Math.max(0, Math.min(spec.priceMaxDecimals, 5 - intDigits));
  const scale = 10 ** decimals;
  const scaled = px * scale;
  // Snap away float noise before directional rounding (84000.1 * 10 = 840000.9999…).
  const snapped = Math.abs(scaled - Math.round(scaled)) < 1e-6 ? Math.round(scaled) : scaled;
  const fn = mode === 'down' ? Math.floor : mode === 'up' ? Math.ceil : Math.round;
  const rounded = fn(snapped) / scale;
  return { px: rounded, str: rounded.toFixed(decimals) };
}

/**
 * Isolated-margin liquidation price estimate (Hyperliquid's documented formula):
 *   liq = entry − side × marginAvailable / size / (1 − mmr × side)
 * with marginAvailable = notional × (1/leverage − mmr). Ignores fees, which only
 * move liquidation slightly closer; the liquidation buffer ratio absorbs that.
 */
export function liquidationPrice({ entryPx, direction, leverage, mmr }) {
  const side = direction === 'long' ? 1 : -1;
  return entryPx * (1 - (side * (1 / leverage - mmr)) / (1 - mmr * side));
}

/**
 * Builds the complete order plan for a trade. Never throws; returns null when
 * the inputs can't produce a plan (missing mark, stop or equity, or stop at mark).
 *
 * @param {object} p
 * @param {'long' | 'short'} p.direction
 * @param {number} p.mark
 * @param {number} p.stop      raw clipboard value
 * @param {number} p.equity
 * @param {object} p.config
 * @param {import('./marketSpec.js').MarketSpec} p.spec
 * @param {number} [p.takerFeeRate]  the account's taker rate, for the fee estimate
 */
export function computePlan({ direction, mark, stop, equity, config, spec, takerFeeRate = DEFAULT_TAKER_FEE }) {
  if (!(mark > 0) || !(stop > 0) || !(equity > 0) || !spec) return null;
  const side = direction === 'long' ? 1 : -1;

  // Round the stop first and size from the rounded value, so rounding can't add risk.
  const stopPx = roundPrice(stop, spec, 'nearest');
  const stopDistance = Math.abs(mark - stopPx.px);
  if (stopDistance === 0) return null;

  const riskBudget = equity * config.riskPct;
  const intendedSize = riskBudget / stopDistance;
  const size = floorToLot(intendedSize, spec.szDecimals);

  // Both entry types are IOC limits; "market" just uses a wider slippage bound.
  const offsetBps = config.entryOrderType === 'market' ? config.marketOrderSlippageBps : config.marketableLimitOffsetBps;
  const entryLimit = roundPrice(mark * (1 + (side * offsetBps) / 10_000), spec, side === 1 ? 'up' : 'down');

  // Stop-market triggers still need a worst-case limit, beyond the trigger.
  const stopLimit = roundPrice(stopPx.px * (1 - (side * config.stopLimitSlippageBps) / 10_000), spec, side === 1 ? 'down' : 'up');

  // Margin and liquidation use the worst-case fill (the entry limit).
  const notional = size.size * mark;
  const worstNotional = size.size * entryLimit.px;
  const margin = worstNotional / config.leverage;
  const mmr = maintenanceMarginRate(spec, worstNotional);
  const liqPx = liquidationPrice({ entryPx: entryLimit.px, direction, leverage: config.leverage, mmr });

  const riskUsd = size.size * stopDistance;

  // Round-trip taker fees if the trade is stopped out: entry at mark, exit at the stop.
  // Sizing fixes risk, so tighter stops mean bigger size and proportionally bigger fees.
  const feesUsd = size.size * (mark + stopPx.px) * takerFeeRate;

  return {
    direction,
    mark,
    stopRaw: stop,
    stopPx: stopPx.px,
    stopPxStr: stopPx.str,
    stopDistance,
    stopDistancePct: stopDistance / mark,
    equity,
    riskBudget,
    intendedSize,
    size: size.size,
    sizeStr: size.str,
    entryLimitPx: entryLimit.px,
    entryLimitPxStr: entryLimit.str,
    stopLimitPx: stopLimit.px,
    stopLimitPxStr: stopLimit.str,
    notional,
    margin,
    mmr,
    liqPx,
    liqDistance: Math.abs(entryLimit.px - liqPx),
    stopDistanceFromWorstEntry: Math.abs(entryLimit.px - stopPx.px),
    riskUsd,
    riskPct: riskUsd / equity,
    takerFeeRate,
    feesUsd,
    feesR: riskUsd > 0 ? feesUsd / riskUsd : null,
  };
}
