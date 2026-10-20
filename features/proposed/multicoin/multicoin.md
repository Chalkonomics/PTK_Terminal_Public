# Feature: Multi-coin trading

**Status:** planned, not started. Discussed 2026-10-05.
**Effort:** about 2 days including tests and a testnet pass.
**Goal:** take a setup on a coin other than BTC (e.g. after an alert for SOL) using the same copy-stop-plus-hotkey flow, with the same fixed-R discipline.

> Scope note: the trader mentioned "SOL/USDC". On Hyperliquid that is the **spot** pair, which has no leverage and no exchange-side reduce-only stops, so the tool can't trade it. This feature is about **perpetuals** (SOL-PERP, FET-PERP, …).

---

## Decisions

| Decision | Status |
|---|---|
| **One open position per coin** (BTC and SOL may be open at the same time, never two on the same coin) | **Decided** by the trader |
| Expected isolated leverage: **BTC 20x, SOL 20x, FET 5x** | **Decided** (FET's max is 5x) |
| Leverage is still set manually in the Hyperliquid UI per coin and only *verified* by the tool | Unchanged rule |
| Panic (Ctrl+0) flattens **every** coin and cancels every order; optional "Close selected coin" menu item | **Proposed, needs confirming** |
| Initial watchlist: **BTC, SOL, FET** | **Proposed, needs confirming** |

---

## Why leverage is a smaller problem than it looks

With fixed-R sizing, **leverage never affects risk**. Size comes from the stop distance alone (`size = equity × riskPct / |mark − stop|`). Leverage only sets how much margin is locked and where liquidation sits.

- The liquidation and margin checks already read each coin's margin tiers from `meta` (`marketSpec.js`), so they adapt automatically.
- Lower leverage puts liquidation **further** away (wider stops allowed) but needs **more margin** (very tight stops get refused by the margin check).

Approximate numbers at 1,000 USDC equity, 1% risk (R = 10), 80% max margin usage, 1.2× liquidation buffer:

| | BTC 20x | SOL 20x | FET 5x |
|---|---|---|---|
| Liquidation distance | ~3.8% | ~3.8–4.5% (depends on SOL's margin tier) | **~11%** |
| Widest stop allowed | ~3% | ~3% | **~9%** |
| Tightest stop before the margin check refuses | ~0.06% | ~0.06% | **~0.25%** |
| Margin for a 1% stop | ~50 | ~50 | ~200 |

The tightest-stop figure is `R ÷ (0.8 × free collateral × leverage)`. With another position open, free collateral is lower, so this floor rises.

**Fees** depend on stop *percentage*, not price: round-trip fees ≈ `2 × 0.045% ÷ stop%` R. A 1% stop costs ~0.09R; an 80-point BTC stop (~0.09%) costs ~1R.

Verify each coin's real `maxLeverage` and margin tiers from `meta` at build time; the numbers above are from the discussion.

---

## Issues to solve

1. **USD stop limits don't carry over.** `minStopDistance: 80` USD means nothing on a $150 or $0.60 coin. Use **percentage limits per coin** (`minStopDistancePct`, `maxStopDistancePct`), keeping the USD minimum only as an optional per-coin override (BTC 80).
2. **Coin selection is the main safety risk.** The tool can't see which chart is open, so the coin must be chosen explicitly and be unmissable on the panel.
   - Existing protection: the ±10% magnitude check catches a SOL price pasted while BTC is selected.
   - **New rule:** after switching coin, the clipboard stop must have been copied *after* the switch, so a price copied for the previous coin can't be fired.
   - Gap: coins with similar prices aren't caught by the magnitude check, which is why the label must be prominent (large, maybe colour-coded per coin).
3. **Liquidity on smaller coins (FET etc.)** is a bigger practical issue than leverage:
   - **Partial fills** at the 5bp marketable limit mean less than 1R taken.
   - **Stop slippage** on thin books means a stopped trade can lose **more than 1R**.
   - **Wider spreads** mean worse entry slippage.
   - Mitigation: **per-coin `marketableLimitOffsetBps` and `stopLimitSlippageBps`**. The journal's `riskUsd`, `slippageBps` and `pnlR` columns show the real cost per coin.
4. **Multiple open positions** (consequence of one-per-coin):
   - Total risk can exceed 1R (two coins open means 2R). Deliberate; worth surfacing on the panel.
   - Free collateral is shared; `activeAssetData.availableToTrade` already reflects margin locked elsewhere.
   - Positions on non-selected coins must stay visible (see Panel).
5. **Lot rounding:** some coins have coarse `szDecimals` (e.g. whole units). Size still rounds down, so risk stays at or below 1%, but it can fall noticeably below. The panel's risk % already shows this.

---

## Design

### Config: watchlist
Replace the single `symbol` with a watchlist. Per-coin keys are optional and fall back to global defaults:

```jsonc
"coins": {
  "BTC": { "leverage": 20, "minStopDistance": 80, "maxStopDistancePct": 0.03 },
  "SOL": { "leverage": 20, "minStopDistancePct": 0.002 },
  "FET": { "leverage": 5, "maxStopDistancePct": 0.08, "marketableLimitOffsetBps": 15, "stopLimitSlippageBps": 200 }
},
"defaultCoin": "BTC"
```
Values above are illustrative. Validate that every coin exists in `meta` and isn't delisted, and that each `maxStopDistancePct` is inside that coin's liquidation distance.

### Market data (`market.js`)
- Load a `MarketSpec` per watchlist coin.
- Subscribe `activeAssetCtx` for every watchlist coin so switching is instant and marks are always fresh.
- `activeAssetData` per coin (leverage and availableToTrade are per coin).
- `clearinghouseState` / `openOrders` are already account-wide; `deriveAccount` must return positions and orders **per coin** instead of filtering to one.

### Selection
- **☰ menu → Asset ▸ BTC / SOL / FET**, plus an optional hotkey to cycle coins.
- Switching coin needs **no relaunch** (unlike mode); it changes the selected coin in the store.
- Allowed while positions are open on other coins. Blocked while a press or panic is running.
- Record `selectedAt` and enforce "clipboard captured after selectedAt" in the gate.

### Gate (`gate.js`)
- Runs against the selected coin's spec, mark, leverage and per-coin thresholds.
- `noPosition` / `noOrders`: **selected coin only**.
- `leverage`: expected value from that coin's config.
- New check: stop copied after the coin was selected.
- Mode-switch blockers (`session.js`): still block if **any** coin has a position, orders, or a journal-tracked trade.

### Orders / remediation / panic
- `buildOrderAction` already uses `spec.assetId`; pass the selected coin's spec.
- Remediation (`protect.js`) works on the coin of the trade being fixed, not whatever is selected *now*. Capture the coin at press time.
- **Panic:** cancel all orders and flatten all positions across every coin (proposed). Optional menu item "Close selected coin".

### Panel
- **Large coin label** in the header, maybe colour-coded per coin.
- **"Open positions" strip:** every coin with a position, showing size, P&L and stop status (✓ / partial / NONE), even when another coin is selected.
- Optionally show total open risk in R across coins.

### Journal (`journal.js`)
- Add a **`coin`** column. Changing the CSV columns means either starting a new `trades.csv` or a one-off migration of the existing file (decide at build time).
- `open-trade.json` becomes a map keyed by coin, so several trades are tracked at once, each with its own mark samples for MAE/MFE.
- Fill matching already filters by `coin`.

---

## Where the code assumes BTC today

| Location | Assumption |
|---|---|
| `src/main/config.js` | `symbol: 'BTC'` default; validation rejects anything but BTC; single `leverage`, `minStopDistance` |
| `src/main/market.js` | `const coin = config.symbol`; one spec, one `activeAssetCtx` and one `activeAssetData` subscription |
| `src/main/account.js` | `deriveAccount` filters position and orders to one coin |
| `src/main/gate.js` | uses the single `market.spec` / `mark`; thresholds from global config |
| `src/main/actions.js`, `protect.js` | operate on `market.snapshot().spec` (the one coin) |
| `src/main/journal.js` | single `open` trade; `newTradeRecord(... coin: config.symbol)`; no `coin` CSV column |
| `src/main/store.js`, renderer | `symbol` shown as a small label; single position card |
| Tests | fixtures assume BTC (`test/fixtures.js` SPEC) |

---

## Rough plan

1. Config watchlist and validation against `meta` (½ day)
2. Per-coin market data, account derivation and gate (½ day)
3. Coin switcher, header label, "copied after switch" rule, open-positions strip (½ day)
4. Journal (`coin` column, multiple open trades), panic across coins, remediation keyed by trade coin (½ day)
5. Tests, then a testnet pass on SOL (and FET if listed on testnet), including fault injection

## Open questions
1. Panic flattens all coins: confirm. Add "Close selected coin"?
2. Watchlist: BTC, SOL, FET to start?
3. Journal: new `trades.csv` or migrate the existing one when the `coin` column is added?
4. Show total open risk (sum of R across coins) on the panel?
5. Coin-cycle hotkey: wanted? Which combo? (Must be checked as free; see the Ctrl+Shift+X conflict in `index.md`.)
