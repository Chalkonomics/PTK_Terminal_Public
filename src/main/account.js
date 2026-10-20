// Pure normalisation of raw exchange account responses. No network access.

/**
 * Normalises raw exchange responses into the account shape the gate and panel use.
 * Returns null until every source has been received.
 */
export function deriveAccount({ spec, abstraction, clearinghouse, orders, assetData, spot }) {
  if (!spec || !abstraction || !clearinghouse || !orders || !assetData || !spot) return null;
  const coin = spec.symbol;
  const unified = abstraction === 'unifiedAccount';

  const raw = clearinghouse.assetPositions.find((p) => p.position.coin === coin && Number(p.position.szi) !== 0)?.position;
  const position = raw
    ? {
        size: Number(raw.szi),
        entryPx: Number(raw.entryPx),
        unrealizedPnl: Number(raw.unrealizedPnl),
        liquidationPx: raw.liquidationPx === null ? null : Number(raw.liquidationPx),
        marginUsed: Number(raw.marginUsed),
        leverage: raw.leverage,
      }
    : null;

  const btcOrders = orders
    .filter((o) => o.coin === coin)
    .map((o) => ({
      oid: o.oid,
      cloid: o.cloid,
      side: o.side,
      size: Number(o.sz),
      limitPx: Number(o.limitPx),
      isTrigger: o.isTrigger,
      triggerPx: o.isTrigger ? Number(o.triggerPx) : null,
      reduceOnly: o.reduceOnly,
      isPositionTpsl: o.isPositionTpsl,
      orderType: o.orderType,
    }));
  if (position) position.stop = findStop(position, btcOrders);

  return {
    // Only meaningful while flat for unified accounts (an open isolated position's margin
    // sits inside the spot total). Sizing only ever happens while flat.
    equity: unified ? spotTotal(spot, spec.collateralToken) : Number(clearinghouse.marginSummary.accountValue),
    equityBasis: unified ? 'unified (spot USDC)' : 'perp account value',
    position,
    orders: btcOrders,
    leverage: { type: assetData.leverage.type, value: assetData.leverage.value },
    availableToTrade: { buy: Number(assetData.availableToTrade[0]), sell: Number(assetData.availableToTrade[1]) },
  };
}

/**
 * The reduce-only stop protecting a position: a trigger on the closing side.
 * Position-TPSL orders report size 0 and always cover the whole position.
 * @returns {{ oid: number, triggerPx: number, coversSize: boolean } | null}
 */
export function findStop(position, orders) {
  const closingSide = position.size > 0 ? 'A' : 'B';
  const stop = orders.find((o) => o.isTrigger && o.reduceOnly && o.side === closingSide && o.orderType.startsWith('Stop'));
  if (!stop) return null;
  return {
    oid: stop.oid,
    triggerPx: stop.triggerPx,
    coversSize: stop.isPositionTpsl || stop.size >= Math.abs(position.size),
  };
}

function spotTotal(spot, token) {
  return Number(spot.balances.find((b) => b.token === token)?.total ?? 0);
}

/** Returns a reason string if the account's leverage setting doesn't match config, else null. */
export function leverageMismatch(account, expected) {
  if (!account) return 'account data not loaded';
  const { type, value } = account.leverage;
  if (type !== 'isolated' || value !== expected) {
    return `${account.leverage.type} ${value}x set on exchange; expected isolated ${expected}x (set it manually in the Hyperliquid UI)`;
  }
  return null;
}
