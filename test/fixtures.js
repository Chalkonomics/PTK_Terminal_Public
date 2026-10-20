// Shared test fixtures. Not a test file (no .test.js suffix).

/** BTC rules as observed from mainnet meta on 2026-10-03. */
export const SPEC = {
  symbol: 'BTC', assetId: 0, szDecimals: 5, lotSize: 0.00001, priceMaxDecimals: 1, maxLeverage: 40,
  marginTiers: [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150_000_000, maxLeverage: 20 }],
  collateralToken: 0,
};
