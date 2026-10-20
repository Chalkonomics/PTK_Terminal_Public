// Pure extraction of per-market trading rules from the `meta` info response.
// Nothing here is hard-coded: lot size, leverage and margin tiers all come from the exchange.

/**
 * @param {import('@nktkas/hyperliquid').MetaResponse} meta
 * @param {string} symbol
 * @returns {MarketSpec}
 */
export function parseMarketSpec(meta, symbol) {
  const assetId = meta.universe.findIndex((u) => u.name === symbol);
  if (assetId === -1) throw new Error(`${symbol} not found in exchange meta`);

  const asset = meta.universe[assetId];
  if (asset.isDelisted) throw new Error(`${symbol} is delisted`);

  // Tables with ids below 50 are implicit single-tier tables whose id is the max leverage,
  // so they may not be listed. Fall back to one tier at the asset's max leverage.
  const table = meta.marginTables.find(([id]) => id === asset.marginTableId)?.[1];
  const marginTiers = table
    ? table.marginTiers
        .map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: t.maxLeverage }))
        .sort((a, b) => a.lowerBound - b.lowerBound)
    : [{ lowerBound: 0, maxLeverage: asset.maxLeverage }];

  return {
    symbol,
    assetId,
    szDecimals: asset.szDecimals,
    lotSize: Number(`1e-${asset.szDecimals}`), // exact literal; 10 ** -5 is 0.000009999…
    priceMaxDecimals: Math.max(6 - asset.szDecimals, 0),
    maxLeverage: asset.maxLeverage,
    marginTiers,
    collateralToken: meta.collateralToken,
  };
}

/**
 * Maintenance margin rate for a position of the given notional: half the initial
 * margin rate at the applicable tier's max leverage.
 */
export function maintenanceMarginRate(spec, notional) {
  let tier = spec.marginTiers[0];
  for (const t of spec.marginTiers) if (notional >= t.lowerBound) tier = t;
  return 1 / (2 * tier.maxLeverage);
}

/**
 * @typedef {object} MarketSpec
 * @property {string} symbol
 * @property {number} assetId          index in meta.universe, used as the order `a` field
 * @property {number} szDecimals
 * @property {number} lotSize
 * @property {number} priceMaxDecimals
 * @property {number} maxLeverage
 * @property {{ lowerBound: number, maxLeverage: number }[]} marginTiers
 * @property {number} collateralToken  spot token index of the margin asset (0 = USDC)
 */
