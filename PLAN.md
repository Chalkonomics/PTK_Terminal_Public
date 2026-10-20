# PTK Terminal — Build Plan

Implementation plan for `Hyperliquid 1m Scalp Entry Tool — Build Spec.md`. Where this plan and the spec disagree, the corrections below explain why.

## Corrections to the spec

1. **The default stop band can put the stop past liquidation.** On isolated margin, liquidation sits about `1/leverage − maintenanceMargin` from entry. Maintenance margin is half the initial margin at max leverage, and BTC max leverage is 40x, so at 20x that's 5% − 1.25% ≈ **3.75%**, not 5%. `maxStopDistancePct` therefore defaults to `0.03`. The liquidation estimate uses `meta.maxLeverage` instead of a hard-coded figure.
2. **There is no tick size.** Prices may have at most 5 significant figures and at most `6 − szDecimals` decimals (whole dollars for BTC at ~83k). Lot size is `10^-szDecimals` (0.00001 BTC). Both are derived from `meta`.
3. **There are no true market orders.** A "market" entry is an IOC limit with a wide offset (`marketOrderSlippageBps`). A stop-market trigger also needs a worst-case limit price (`stopLimitSlippageBps`).
4. **`accountAddress` is required.** Info queries (position, equity, orders) run against the main account's public address, not the agent wallet's. It goes in `config.json`, is not secret, and is needed even in dry run unless `equitySource` is `fixed`.
5. **Leverage verification uses `activeAssetData`** (user + coin), which works while flat and also returns `availableToTrade` for the margin check.
6. **Client order IDs (cloids) are 16-byte hex.** Each one is derived from the trade UUID, with the entry and the stop getting distinct cloids.
7. **Leftover stops.** After a manual exit, the reduce-only trigger may stay on the book and check 3 would then refuse every trade. Once the tool sees BTC go flat, it cancels the leftover BTC triggers. This is cleanup, not stop adjustment.
8. **Unified accounts.** Perp collateral lives in the spot USDC balance and the perp account value reads 0. Equity = spot USDC total (`spotClearinghouseState`), the source of truth per Hyperliquid's docs. It's only unambiguous while flat, which is the only time sizing runs. Portfolio-margin accounts are refused. Free collateral comes from `activeAssetData.availableToTrade`, which handles unified accounts correctly (verified on the trader's account).
9. **Entry and stop are sent as one action** with `grouping: "normalTpsl"`. Partial-fill behaviour has to be confirmed on testnet; the reconcile path covers it either way.

## Stack

- **Electron** main process: plain ESM JavaScript, unbundled. Owns all logic.
- **React (JSX) + Vite** for the status panel renderer. Display only, no logic.
- `@nktkas/hyperliquid`, `viem`, `dotenv`.
- Tests: built-in `node:test` (`npm test`). The pure modules have no Electron imports, so they test without a window.

Electron 44's `clipboard.readText()` is async (returns a Promise). The watcher awaits it and skips a tick if the previous read is still running.

Renderer gets state only through a preload bridge (`window.ptk.onState`). `contextIsolation` on, `nodeIntegration` off, sandboxed.

## Layout

```
src/
  main/
    index.js       app lifecycle, window, wiring, single-instance lock
    config.js      config.json + defaults + validation; agent key loaded only outside dry run
    parse.js       PURE strict clipboard parser
    clipboard.js   poller → { raw, value, error, capturedAt, ageMs }
    market.js      meta, WS mark (activeAssetCtx), account/position/order state
    sizing.js      PURE size, rounding, notional, margin, liquidation estimate
    gate.js        PURE validate(snapshot, direction) → { ok, check, detail, plan }
    orders.js      order manager state machine, reconcile, auto-flatten, panic
    hotkeys.js     registration with return-value checks, press lock
    journal.js     CSV, MAE/MFE at 1Hz, close detection, open-trade sidecar
    store.js       central state, 5Hz snapshot to renderer
  preload.cjs
  renderer/
    index.html, main.jsx, App.jsx, panel.css
    components/    ModeBadge, ReadyLight, StopReadout, SizingTable, PositionCard, LastAction, SetupPicker
    sounds/
test/
```

## Design rules

- **One gate.** `gate.validate()` drives both the ready light (5Hz, inferred direction) and the hotkey press (chosen direction), so the panel can't disagree with what a press will do.
- **State on press.** The WebSocket feeds the panel. On a press, the tool fetches `clearinghouseState`, `frontendOpenOrders` and `activeAssetData` in parallel and checks 2, 3 and 10 run on that fresh data.
- **Order manager:** `idle → submitting → (reconciling) → protected | flattening → idle`. A press lock covers the whole sequence. On a timeout or unclear response, never retry the entry: query the position, then attach the stop or flatten. If the stop is rejected, retry once, then flatten.
- **Press lock plus a 1.5s cooldown.** Windows auto-repeats a held hotkey, so a lock alone would let a held key fire again the moment the first sequence finished.
- **Check 12 measures from the keypress.** The mark is captured when the key is pressed. Size is computed from the mark after the account refresh, and the press is refused if price moved more than `maxSlippageBps` in between. In milestone 6 it is re-checked against the plan immediately before sending.
- **Exchange state decides every outcome.** After each submission the position and orders are read back over REST. The result is *protected*, *not filled*, *unprotected* or *unknown* (re-checked once after 600ms). The response only supplies detail, such as fill price or stop error. The SDK throws when any order in a batch errors but keeps the full response on the error, so "entry filled, stop rejected" is recovered rather than mistaken for a failure.
- **"Orders enabled" is gate check 0.** It covers executor readiness (key present, agent approved and unexpired) and `LIVE_ENABLED` (false until milestone 7). Being in the gate keeps the ready light honest in testnet and live.
- **Remediation (`protect.js`).** An unprotected position gets one full-size stop retry, then a reduce-only IOC flatten at 50, 200, then 500bp until flat is confirmed. An unclear outcome is reconciled with up to 3 reads and the entry is never re-sent. If the exchange can't be read, a blind reduce-only close of the planned size is sent; reduce-only can't open or flip, so this is always safe. If the exchange reported a fill but the account is already flat, the outcome is *closedImmediately* (a real trade), not "not filled". Panic cancels all BTC orders, flattens the same way, and stops any press in progress at its next step.
- **Testnet fault injection** (`PTK_FAULT`, ignored outside testnet): `bad-stop` (exchange rejects the whole action), `stop-wrong-side` (stop accepted and triggers immediately), `no-stop` (entry with no stop, then the stop retry is rejected). All three were run on testnet. `no-stop` confirmed retry rejected → auto-flatten → flat, about 5.8s end to end at testnet latency.
- **Leftover stops.** Hyperliquid cancelled the reduce-only stop itself when the position was closed by a reduce-only order. Remediation and panic still cancel leftovers explicitly.
- **Journal (`journal.js`).** `trades.csv` gets one row per trade, appended when the trade closes. While a trade is open it lives in `open-trade.json`, so tracking survives a restart. This differs from the spec's "write on fill, complete on close": appending a finished row avoids rewriting a CSV that Excel may have locked. Exit details come from `userFillsByTime`: VWAP entry and exit, summed fees, gross P&L. `pnlUsd` and `pnlR` are net of fees, and R is `plannedRiskUsd`. Exit reason is `stopped` (stop order id or exit at/beyond the stop), `manual`, `panic`, `autoFlatten` or `liquidated`. MAE/MFE come from 1Hz mark samples. Dry-run presses are logged with `mode=dryRun`. Rows refused by a locked file are queued in `journal-pending.jsonl` and retried every second. Extra columns beyond the spec: `plannedRiskUsd`, `entryOrderType`, `outcome`.
- **Dry run never loads the key.** Testnet/live refuse to start if leverage isn't isolated at `config.leverage`.
- **Initial clipboard content is treated as stale** (unknown capture time). A stop copied before launch can't be fired.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| 1 | Scaffold (Electron + React/Vite), config, parser, clipboard watcher | Copying `83,298` shows value + age; junk rejected; parser tests pass |
| 2 | Market data: meta, WS mark, account state | Mark streams; rounding rules derived from meta |
| 3 | `sizing.js` + `gate.js` with full unit tests | Spec test list passes, plus stop-beyond-liquidation and rounding edges |
| 4 | React panel rendering the store at 5Hz | All spec fields present; ready light matches the gate |
| 5 | Hotkeys, press lock, sounds (dry run) | **Phase 1 usable** |
| 6 | Signing + submission on testnet | Fills and an exchange-side stop on testnet |
| 7 | Failure handling, reconcile, panic, leftover-stop cleanup | Forced stop rejection and forced timeout both end flat or protected |
| 8 | CSV journal, MAE/MFE, close detection | Complete rows for stopped / manual / panic exits |

## Dependency hygiene

- Exact versions only (`.npmrc` `save-exact=true`), lockfile committed, installs via `npm run setup` (`npm ci` + Electron binary fetch).
- Install scripts disabled (`ignore-scripts=true`).
- `@nktkas/hyperliquid` is single-maintainer and pre-1.0: read its signing code for the pinned version before the agent key is first used (milestone 6), and only upgrade deliberately with a testnet re-run.
- Add `viem` only if the SDK actually needs it.

## Open decisions

- **Equity source:** recommend `fixed` for the evaluation window (R constant in dollars).
- **Setup labels:** replace A/B/C with real pattern names before Phase 1 data counts.
- **Re-copying the same price:** the clipboard has no change counter in Electron, so copying an identical string again does not reset the age. Options: clear the clipboard after each fire (forces a fresh copy per trade), or read Windows' `GetClipboardSequenceNumber` through FFI. Decide before milestone 5.
