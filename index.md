# PTK Terminal — Project Index

Start here when picking up this project. It covers what the tool is, how it is built, how each part works, what has been verified against the real exchange, and the traps already hit. The original requirements are in `Hyperliquid 1m Scalp Entry Tool — Build Spec.md`, and `PLAN.md` holds the build plan and design decisions. Where this file and the spec disagree, the spec was wrong and this file explains why (see [Corrections to the spec](#corrections-to-the-spec)).

---

## 1. What it is

A Windows desktop tool for one trader who scalps **BTC perpetuals on Hyperliquid** on the 1-minute chart. The trader:

1. sees a setup on the Hyperliquid chart,
2. right-clicks the stop level and copies the price (the clipboard then holds something like `83,298`),
3. presses a global hotkey for long or short.

The tool reads the clipboard, validates everything, sizes the position so that **risk is exactly 1% of equity** (`riskPct`), then sends an IOC entry and a reduce-only stop-market at the copied price as a single signed action. The whole sequence takes well under a second of local work plus network time.

**Non-negotiable design rules:**
- **Fixed R.** Size floats and risk is fixed. Size always rounds *down*. The trader is gathering data, so R must be a constant unit.
- **The stop lives on the exchange,** never only in this process.
- **An unstopped position is never left open.** Stop failure leads to one retry, then flatten.
- **Leverage is never set by the tool.** It is verified to be isolated at `config.leverage` (20x) and set manually in the Hyperliquid UI.
- **No stop moving, no resizing, no take-profit, BTC only, one position at a time.** These are deliberate.
- Exits are manual in the Hyperliquid GUI (the trader's choice) or via the panic key.

---

## 2. Status

- All 8 spec milestones are built, plus the Notion sync and the trades dashboard. `npm test` runs the suite.
- **Rollout:** Phase 1 (dry run), then Phase 2 (testnet), then live.
- **Before going live:**
  - add `HL_AGENT_KEY_MAINNET` to `.env` (a separately authorised **mainnet** API wallet),
  - set `"mode": "live"` and `"riskPct": 0.0025` for the first ~20 trades,
  - replace the `setupLabels` placeholders with real pattern names.

### Backlog (agreed or discussed, not built)

| Item | Notes |
|---|---|
| Multi-coin trading | Planned, see **`features/proposed/multicoin/multicoin.md`** (decisions, design, where the code assumes BTC, open questions). |
| Package as an installed app | Deferred until settings stabilise. Needs config, `.env` and journal moved to Electron's `userData`, plus the log file. |
| Panel height | ~550–680px; could hide the account section while flat. |

---

## 3. Running it

```
npm run setup     # first time / fresh clone: npm ci + download Electron binary
npm start         # build the panel, then run the app
npm run dev       # Vite dev server + Electron with hot reload of the panel
npm test          # node --test (all test/*.test.js)
```

**Local-only files** (gitignored; never commit, never print):

| File | Contents |
|---|---|
| `config.json` | Your settings, including your main wallet's public `accountAddress`. Copy from `config.example.json`. |
| `.env` | `HL_AGENT_KEY_TESTNET=0x…` and `HL_AGENT_KEY_MAINNET=0x…` (64 hex each). Separate API (agent) wallets per network; never the main wallet key. The key is picked by `mode` (`agentKeyVar()` in `config.js`); dry run reads neither. The old `HL_AGENT_PRIVATE_KEY` is no longer read, and an error says to rename it. |
| `trades.csv` | The journal. |
| `open-trade.json` | The trade currently being tracked by the journal. |
| `journal-pending.jsonl` | Journal rows waiting because the CSV was locked. |
| `logs/ptk-YYYY-MM-DD.log` | Activity log: every line the app reports (orders, responses, outcomes, remediation, panic, journal, hotkeys, crashes), timestamped. Daily files, kept 30 days. |

Settings are read **only at startup**, so restart after editing `config.json` or `.env`.

**Switching networks:** change `"mode"` in `config.json` (`dryRun` / `testnet` / `live`) and restart. The matching key is chosen automatically. If a key isn't authorised on the selected network, the executor's `extraAgents` check fails, the panel shows red "Orders enabled … not approved", and nothing can be sent. Dry run uses mainnet market data and never loads a key.

---

## 4. Architecture

One Electron app, two processes. **All logic is in the main process.** The renderer only displays state.

```
                         ┌──────────────────────────── MAIN PROCESS (src/main, plain ESM JS) ───────────────────────────┐
 OS clipboard ──250ms──► clipboard.js ──┐                                                                                  │
                                        │                                                                                  │
 Hyperliquid WS/REST ◄─► market.js ─────┼──► store.js ──── validate() ◄── gate.js ◄── sizing.js, account.js               │
   (mark, account,        (state)       │    (snapshot)        │                                                           │
    orders, fees)                       │        │ 5Hz IPC     │ same function                                             │
                                        │        ▼             ▼                                                           │
 Global hotkeys ───────► hotkeys.js ──► actions.js ── press(): refresh → gate → check 12 → orders.js submit                │
                                        │     │          → read back → protect.js ensureProtected → report → journal       │
                                        │     └─ panic(): cancel all → flatten (protect.js)                                │
                                        │                                                                                  │
                                        └──► journal.js (1Hz tick: MAE/MFE sample, close detection, CSV writes)            │
                         └────────────────────────────────────────────────────────────────────────────────────────────────┘
                                         │ 'state' (5Hz), 'sound'            ▲ 'set-setup-label', 'resize', 'close-app'
                                         ▼                                   │
                         RENDERER (src/renderer, React + Vite) via preloads/panel.cjs bridge `window.ptk`
```

**Windows.** `windows.js` opens each window by name with its own page and preload. The panel is the only window with the `command` channel. The trades dashboard (`dashboard.html`, preload `window.dashboard`) can only read trades and open Notion links. Every IPC handler checks which window sent the message. Spec: `features/proposed/trades_dashboard/spec.md`.

### Module map

| File | Pure? | Responsibility |
|---|---|---|
| `activityLog.js` | ✓ (fs injected) | Daily activity log in `logs/`. Mirrors to the console, scrubs anything shaped like a private key (`0x`+64 hex, which also scrubs tx hashes), prunes files older than 30 days, never throws. All modules receive its `log` via their `log` dependency. Crashes are recorded with `process.on('uncaughtExceptionMonitor')`, which observes without changing crash behaviour. |
| `src/main/index.js` | — | App lifecycle and wiring. Single-instance lock (two instances would fight over hotkeys), 5Hz panel push, 1Hz journal tick, IPC handlers (each checks the sending window), unregisters hotkeys on quit. A mode-switch relaunch passes `--reopen=<window>` so open extra windows come back. |
| `windows.js` | ✓ (Electron injected) | Window manager: `open(name)` creates or focuses, `get`, `send`, `isFrom(name, event)`, `openExtras()`. `windowSpecs()` defines the panel (frameless, always-on-top) and the dashboard (normal window, bounds saved in `window-state.json` and dropped if off-screen). |
| `dashboard.js` | ✓ | Trades dashboard, main side: `createTradesReader` caches Notion reads per range (cleared when a close lands in Notion, or on refresh; failures aren't cached). `isNotionUrl` limits what the dashboard can open. |
| `config.js` | mostly | Loads `config.json` over `DEFAULTS` and validates every key (throws listing all problems). `loadAgentKey(rootDir, mode)` reads the mode's key from `.env` (only called outside dry run). Validates that sound files exist in `effects/`. |
| `parse.js` | ✓ | Strict clipboard parser. Whitelist `[0-9,. ]`, max 24 chars, strip commas and spaces, one `.` at most, > 0. |
| `clipboard.js` | ✓ (injected `readText`) | Polls the clipboard and timestamps changes. Content present **at startup has unknown age** (`ageMs = Infinity`) and can't be fired. |
| `marketSpec.js` | ✓ | From `meta`: `assetId`, `szDecimals`, `lotSize`, `priceMaxDecimals`, `maxLeverage`, `marginTiers`, `collateralToken`. `maintenanceMarginRate()`. |
| `market.js` | — | Hyperliquid info and WS. Subscriptions: `activeAssetCtx` (mark), and if `accountAddress` is set, `clearinghouseState`, `openOrders`, `activeAssetData`, `spotState`. `refreshAccount()` fetches all of these over REST in parallel and is used at press time and for read-backs. Also `userAbstraction`, `userFees` (taker rate) and `fetchFills()`. Reconnects every 5s on error. **Never signs.** |
| `account.js` | ✓ | `deriveAccount()` turns raw responses into `{equity, equityBasis, position{…, stop}, orders, leverage, availableToTrade}`. `findStop()` finds the reduce-only stop on the closing side and whether it covers the full size. `leverageMismatch()`. |
| `sizing.js` | ✓ | `floorToLot`, `roundPrice` (Hyperliquid rules), `liquidationPrice`, `computePlan()`: the full order plan including fees. |
| `gate.js` | ✓ | `validate()`: the ordered checks, used for **both** the panel's ready light and the press. `markMoved()` (check 12). `LIVE_ENABLED` kill switch. |
| `store.js` | ✓ (`buildPanelState`) | Central UI state (setup label, last action, hotkeys, busy). `snapshot()` builds the IPC-safe panel state (no `Infinity`, no secrets). |
| `hotkeys.js` | ✓ (injected `globalShortcut`) | Registers shortcuts and **checks every return value**. `register()` returns `false` when another app owns the combo; it doesn't throw. |
| `actions.js` | ✓ (all deps injected) | `press(direction)` and `panic()`. Press lock plus 1.5s cooldown. Reports outcomes and plays sounds. |
| `orders.js` | mostly | `buildOrderAction`, `classifySubmission`, `assessOutcome` (pure). `createExecutor()` loads the key via viem, checks agent approval with `extraAgents`, and provides `submit`, `placeStop`, `closePosition`, `cancel`. Never throws. Testnet fault injection. |
| `protect.js` | ✓ (deps injected) | Remediation: `ensureProtected`, `flatten`, `cancelAll`. |
| `journal.js` | ✓ (fs injected) | Trade journal. `buildTradeRow` (pure), `createJournal` (open-trade file, CSV append, pending queue). Tells its `mirror` (the Notion sync) about opens, closes and discards. |
| `notion.js` | ✓ (fs + fetch injected) | Notion sync (§11; trader-facing notes in `features/existing/notion-sync.md`). Queued upserts keyed on `tradeId`, mainnet only. `queryTrades({from, to})` is a separate read for the dashboard (Missed unticked, not Open, paginated); it never touches the queue. `onWrite` fires after a close or discard lands. |
| `session.js` | ✓ (fs injected) | `switchBlockers()` (reasons a mode switch must wait: press/panic running, account not loaded, position open, orders resting, journal tracking a trade), `saveConfigPatch()` (validate, write `config.json.tmp`, rename), `loadUiPrefs`/`saveUiPrefs` (`ui-state.json`: alwaysOnTop, compact). |
| `commands.js` | ✓ (effects injected) | The **only** renderer→main channel (`ipcMain.handle('command')`). Allowed commands: `setSetupLabel`, `setMode`, `armLive`, `openJournal`, `openLogs`, `openDashboard`, `toggleAlwaysOnTop`, `toggleCompact`, `resize`, `quit`. None can place an order (a test enforces this). `setMode` re-checks blockers, requires `confirmed` for live, saves config, then relaunches. |
| `src/preloads/panel.cjs` | — | `contextBridge`: `onState`, `onSound`, `command(name, args)`. That's all the panel can do. |
| `src/preloads/dashboard.cjs` | — | `contextBridge`: `getTrades(range)`, `onTradesChanged(cb)`, `openInNotion(url)`. No command channel. |
| `src/renderer/dashboard/*` | — | Trades dashboard (React + Tailwind + shadcn/ui; Tailwind is only loaded by this page). `lib/calendar.js` is the pure date/stats logic (local-day bucketing, Monday weeks, periods, win %, streak), tested in `test/calendar.test.js`. shadcn components live in `components/ui/` (`components.json` at the repo root; import them via the `@/` alias). |
| `src/renderer/*` | — | React panel. `App.jsx` composes `components/` (incl. `Menu.jsx`, the ☰ dropdown, which floats over the panel) and the compact view. `format.js` holds display formatting only. `sounds.js` plays `effects/<file>` or a synthesised beep. |

**Conventions:**
- Pure modules take every dependency as an argument (clock, fs, exchange, sleep), so they test without network or Electron.
- Comments explain *why*, not what.
- Plain JS with JSDoc. No build step for main; Vite only for the renderer.
- Electron security: `contextIsolation` on, `nodeIntegration` off, `sandbox` on.

---

## 5a. ☰ menu, mode switching, LIVE arming

- **Menu:** Mode ▸ (Dry run / Testnet / Live), Open journal, Open log folder, Always on top, Compact view, Quit. It's an in-panel dropdown (`Menu.jsx`) floating over the content, so opening it doesn't grow the window, except in compact view where `.menu-open` sets a min-height.
- **Switching** is greyed out with the reasons while `switchBlockers()` returns anything, and `commands.setMode` re-checks it in main rather than trusting the UI. Live needs a confirm (`needsConfirm` round trip). The new mode is saved atomically to `config.json`, then `app.relaunch()` + `app.quit()` (about 0.5s; every startup check re-runs).
- **LIVE arming:** a normal launch in live is **disarmed**. Gate check 0 fails with `LIVE_DISARMED`, the banner shows "LIVE · DISARMED" and an **Arm LIVE** button (`armLive` command), and `needsArm` in the panel state. Choosing Live from the menu relaunches with `--arm-live` (`ARM_LIVE_FLAG`), so it starts armed: the menu confirm *is* the session's confirmation. The flag is stripped from later relaunches. **Panic never needs arming** (it doesn't go through the gate; tested).
- `npm run dev` no longer uses `concurrently -k`: a relaunch exits the original Electron process, and `-k` would kill Vite with it. In dev, stop Vite with Ctrl+C after quitting the app.

## 5. The press lifecycle (`actions.js`)

1. Ignore if a panic is running, the lock is held, or it's within 1.5s of the last press. (Windows auto-repeats a held hotkey; without the cooldown a held key would fire again as soon as the first press finished.)
2. Record `markAtPress`.
3. `market.refreshAccount()` over REST, so checks 2, 3 and 10 run on exchange truth, not WS cache.
4. `store.gate(direction)` runs `validate()`. On failure: refused sound, plus "Refused LONG: <check>: <reason>".
5. **Check 12:** refuse if the mark moved more than `maxSlippageBps` between the keypress and now.
6. **Dry run:** log the exact action that would be sent, write a `mode=dryRun` journal row, play the accepted sound. Stop here.
7. Re-check the mark against the plan immediately before sending.
8. `buildOrderAction` creates one action: IOC limit entry plus reduce-only stop-market trigger, `grouping: "normalTpsl"`, distinct random cloids (16-byte hex). `executor.submit()`.
9. **Read back** the account and `assessOutcome()`. The exchange state decides; the response only adds detail. If the result is `unknown`, wait 600ms and re-check once.
10. `protector.ensureProtected(plan, outcome)` (see §8).
11. If the entry filled (any outcome in `ENTRY_FILLED_OUTCOMES`), `journal.openTrade(...)`.
12. Report: last-action text, colour and sound.

Sounds: `accepted` (configurable, currently `effects/reload.mp3`), `refused` (two low beeps), `danger` (alarm). These map to filenames in `config.sounds`; `null` means a synthesised placeholder.

---

## 6. The validation gate (`gate.js`)

Checks run in order and the first failure stops evaluation. **The plan is computed even when a check fails** so the panel can show the size alongside the reason. With `direction = null` (the panel's ready light), direction is inferred from stop vs mark.

| # | id | Fails when |
|---|---|---|
| 0 | `execution` | Testnet/live only: executor not ready (no key, agent not approved or expired) or `LIVE_ENABLED` false. Skipped in dry run. |
| 1 | `connection` | Feed not ready, mark older than `markMaxAgeMs` (5s), account not loaded, equity ≤ 0 |
| – | `leverage` | Not isolated at `config.leverage` |
| 2 | `noPosition` | Any BTC position open |
| 3 | `noOrders` | Any resting BTC order |
| 4 | `clipboardParses` | Parser rejected the clipboard |
| 5 | `clipboardFresh` | Age > `clipboardMaxAgeMs` (90s) or unknown. Amber warning above 60s. |
| 6 | `magnitude` | Stop more than ±`magnitudeBandPct` (10%) from mark (catches locale mis-parse and wrong instrument) |
| 7 | `side` | Stop on the wrong side for the pressed key (long needs stop < mark), or stop equals mark |
| 8 | `distance` | < `minStopDistance` (80 USD) or < `minStopDistancePct`, or > `maxStopDistancePct` (3%) |
| 9 | `size` | Rounds to 0, or notional < 10 USD (exchange minimum) |
| 10 | `margin` | Margin > `maxMarginUsage` (80%) of `availableToTrade` for that side. Amber above 50%. |
| 11 | `liquidation` | Liquidation distance < `minLiqToStopRatio` (1.2) × stop distance, measured from the worst-case fill |
| 12 | (`markMoved`) | Separate function, run at press time (see §5) |

Dry run with no `accountAddress` skips `leverage`, `noPosition` and `noOrders` (amber warning). Testnet and live never skip them.

---

## 7. Sizing (`sizing.js`)

```
stopPx       = roundPrice(clipboardStop, 'nearest')       # round first; size from the ROUNDED stop
stopDistance = |mark − stopPx|
size         = floorToLot(equity × riskPct / stopDistance)   # never rounds up
entryLimit   = mark × (1 ± offset)   offset = 5bp (marketableLimit) or 50bp (market); rounded up for buys, down for sells
stopLimit    = stopPx × (1 ∓ 100bp)                        # worst fill for the stop-market
margin       = size × entryLimit / leverage                # worst case
liq          = entry × (1 − side·(1/lev − mmr)/(1 − mmr·side))   # Hyperliquid isolated formula
riskUsd      = size × stopDistance
feesUsd      = size × (mark + stopPx) × takerFeeRate       # round trip if stopped
feesR        = feesUsd / riskUsd
```

- **Equity:** `equitySource: fixed` uses `equityFixed`; `api` uses live account equity (see the unified-account note in §9).
- **Price rules:** max `6 − szDecimals` decimals, max 5 significant figures, integers always allowed. BTC at ~85k means whole dollars.
- **Fees are display only**, amber above 0.5R. They don't block trades.

---

## 8. Failure handling (`protect.js`) and panic

| Outcome after read-back | Action |
|---|---|
| `protected` | Done |
| `notFilled` | Cancel leftover orders, report |
| `unprotected` (no or partial stop) | **One** full-size stop retry (`placeStop`). If that fails, **flatten**: reduce-only IOC at 50, then 200, then 500bp through the mark until confirmed flat, then cancel leftovers. |
| `unknown` | Reconcile: up to 3 reads. **Never re-send the entry.** No position and a fill was reported gives `closedImmediately` (a real trade, e.g. instant stop-out); no position and no fill gives `notFilled`; position without stop is treated as unprotected; wrong-side position is flattened. If the exchange is unreadable, send a **blind reduce-only close** of the planned size (safe because reduce-only can't open or flip), then report `flattenFailed`. |

Final kinds reported: `protected`, `protectedOnRetry` (amber), `notFilled`, `closedImmediately`, `flattened` (danger), `flattenFailed` (danger: "close in UI NOW"), `aborted` (panic took over).

**Panic (`hotkeyPanic`)** ignores the press lock, needs no clipboard, and sets `panicking` so an in-flight press stops before its next remediation step and new presses are ignored. It cancels all BTC orders, flattens with the same widening limits, and confirms flat. In dry run it only describes what it would do. It also flags the open journal trade as `panic`.

---

## 9. Hyperliquid facts verified against the real API

These were measured, not assumed. Re-verify if behaviour changes.

- **BTC asset id is 0 on mainnet and 3 on testnet.** Always take it from `meta` (`spec.assetId`).
- BTC `szDecimals` 5 (lot 0.00001), `maxLeverage` 40. Mainnet margin table "tiered 40x": 40x up to $150M, so maintenance margin is 1.25%. Testnet tiers are stricter (25x above $10k, 10x above $50k).
- **Liquidation at 20x isolated is about 3.75–3.8% away, not the spec's 5%.** That is why `maxStopDistancePct` defaults to 0.03. The liquidation formula matched the exchange's own `liquidationPx` to about $2.
- **Unified accounts** (check with `userAbstraction`): perp collateral sits in the **spot USDC balance**, and `clearinghouseState.marginSummary.accountValue` reads 0. Equity is therefore the spot USDC total, which is unambiguous only while flat (and sizing only happens while flat). `activeAssetData.availableToTrade` handles unified accounts correctly. Portfolio-margin accounts are refused.
- **Mark price** from `activeAssetCtx` arrives about once per second.
- **Taker fee 0.045%** at the base tier (mainnet and testnet; the app reads your own rate from `userFees.userCrossRate`). Round-trip fees ≈ `77 / stopDistance` R at BTC ~85k, so an 80-point stop costs about 0.96R.
- **Order response** for entry + `normalTpsl` stop: `statuses: [{filled:{totalSz,avgPx,oid,cloid}}, "waitingForTrigger"]`. Testnet response time is about 1.0s.
- **The SDK throws `ApiRequestError` if any order in a batch errors** but keeps the full response on `err.response`. `classifySubmission` recovers per-order results from it. Transport errors (timeouts) have no response, so they're classed `ambiguous`.
- **Hyperliquid validates the whole action before executing any of it.** An invalid stop price rejects the entry too ("Order has invalid price.") with a single status.
- **A stop trigger on the wrong side of the market is accepted** and fires immediately.
- **When a position is closed by a reduce-only order, Hyperliquid cancels the reduce-only stop itself.** No leftover was seen after manual closes. The code still cancels leftovers explicitly.
- **IOC partial fills happen on the thin testnet book** (one fill was 26% of the order at 5bp). Mainnet BTC liquidity should fill fully, but a partial fill reduces actual risk below R, and the journal records `intendedSize` vs `filledSize`.
- `extraAgents[].validUntil` is **`null` for agents with no expiry**. Don't compare `null <= Date.now()`.
- Agent (API) wallets can trade but can't withdraw. Info queries use the **main account address** (`accountAddress`), not the agent's.

---

## 10. Journal (`journal.js`)

- **One row per trade, appended to `trades.csv` when the trade closes.** While open, the trade is kept in `open-trade.json` and resumes after a restart. This deliberately differs from the spec's "write on fill, complete on close", which would mean rewriting a CSV that Excel may have locked.
- Columns: the spec's list plus `plannedRiskUsd` (the R unit), `entryOrderType` and `outcome`. See `COLUMNS`.
- **Exit details come from `userFillsByTime`:** VWAP entry and exit, summed fees (USDC), and summed gross `closedPnl`. **`pnlUsd = gross − fees`, `pnlR = pnlUsd / plannedRiskUsd`.** `riskUsd` is the actual risk: filled × |entry − stop|.
- **`exitReason`:** `liquidated`, then `panic`, then `autoFlatten`, then `stopped` (close fill oid matches a known stop oid, **or** the exit is at or beyond the stop price, since a manual close can't fill there), otherwise `manual`.
- **MAE/MFE** come from **mark** samples at 1Hz while a position is open (per the spec). Mark and traded prices can differ slightly, especially on testnet.
- `tick()` every second: flush pending rows, sample the mark, and attempt finalisation when flat. It's throttled to one fill fetch per 5s, because `userFillsByTime` is a heavy request. Records with no entry fill after 60s are discarded (the trade never happened).
- **A locked CSV** (`EBUSY`/`EPERM`, typically Excel) queues rows in `journal-pending.jsonl`, shows a warning on the panel, and retries every second.
- Dry-run presses write `mode=dryRun` rows immediately.

---

## 11. Notion sync (`notion.js`)

- **What it does:** mirrors each **mainnet** trade into a Notion **Trades** database (gallery view; the card colour comes from Trade Outcome). At entry it creates a page with the database's **default template** (Trade Report: the note sections). At close it writes the result columns. The trader fills Setup, Entry, Confluence and Demon by hand. The tool never touches those or the page body.
- **Config:** `notionSync` (off by default) and `notionTestnet` (off; turn it on only to test the sync on testnet, then delete those pages). `.env` holds `NOTION_TOKEN` (an internal **connection**, which is Notion's new name for an integration) and `NOTION_DATABASE_ID`. These are read with `dotenv.parse`, so they never reach `process.env`. Dry run never syncs.
- **Columns** (`PROPS`, names must match Notion exactly):

  | Column | Type | Written |
  |---|---|---|
  | `Name` (title) | title | entry: `BTC Long · 5 Oct 11:19`, local time |
  | `tradeId` (hidden) | text | entry; the upsert key, same as the CSV |
  | `Direction` | select `LONG`/`SHORT` | entry |
  | `Date` | date | entry (UTC instant) |
  | `Asset` | text | entry |
  | `Trade Outcome` | select `Open`/`Win`/`Loss`/`BE` | `Open` at entry; at close from **net** R, BE when \|R\| < 0.1 |
  | `PnL Gross`, `PnL Net` | number ($) | close; gross = net + fees |
  | `R Gross`, `R Net` | number | close; ÷ `plannedRiskUsd` |

  Notion formulas (defined in Notion, not written by the tool): `Fees`, `Fees R`, `Fee Drag`, `Auto Title`. Setup, Entry, Confluence and Demon are **relations to databases not shared with the connection, so the API doesn't return them at all**.
- **Never blocks trading.** The journal calls `mirror.tradeOpened/tradeClosed/tradeDiscarded` inside try/catch. Each call only queues a job in `notion-pending.json`. `tick()` (1Hz, same timer as the journal) sends the oldest job, one at a time and in order. Failures back off 5s → 15s → 60s → 5min, or follow `Retry-After` on a 429. The panel shows `Notion: N update(s) waiting · error`.
- **Every job is an upsert on `tradeId`:** query first, then create (with entry and close columns merged), patch the close columns, or skip. So a retry after a timeout that actually landed never duplicates, and a close whose entry never landed still creates the full page. A discarded trade (no fills) sends its page to the bin (`in_trash`).
- **API:** plain `fetch`, `Notion-Version: 2025-09-03` (databases contain **data sources**; pages are created under `data_source_id`, which is resolved once from the database ID). `template: { type: 'default' }` can't be combined with `children`. The template is applied asynchronously but doesn't overwrite the properties sent with the create (verified).
- **No backfill:** only trades taken while the sync is on are mirrored. Earlier trades have to be added by hand.

---

## 12. Testing

- `npm test` runs `node --test` on `test/*.test.js`; `test/fixtures.js` holds shared data (it's not a test file). **Never import one test file from another**, or its tests run twice.
- `protect.test.js` has a **stateful simulated exchange** (positions, stops, fills at a given slippage, failing reads). Assertions check the final exchange state, not just messages.
- `notion.test.js` uses a fake Notion API (one data source, pages keyed by `tradeId`, injectable 503/429). **Never point tests at the real database.** A one-off check against it should use a clearly fake `tradeId` and bin the page afterwards (`tradeDiscarded`).
- `journal.test.js` uses an in-memory fs that can simulate a locked CSV. **Build expected paths with `path.join`.** On Windows the code produces backslash paths, and hard-coded `'C:/j/…'` keys won't match.
- **Testnet fault injection:** `PTK_FAULT` env var, ignored outside testnet (a test enforces this):
  - `bad-stop`: the exchange rejects the whole action.
  - `stop-wrong-side`: the stop is accepted and fires immediately.
  - `no-stop`: entry with no stop, then the retry is rejected. This verifies retry → flatten → flat (about 5.8s on testnet).
- **Verifying against testnet:** this was done with throwaway `*.tmp.mjs` scripts in the project root, deleted after each run. They import the real modules (market, executor, store, actions, journal), override config in memory (e.g. `entryOrderType: 'market'` so the thin book fills), and **always flatten in a `finally`**. Never do this on mainnet.
- **Driving the real app:** start it with `--remote-debugging-port=N`, then call `window.ptk.command(...)` through the Chrome DevTools Protocol (Node 22's global `WebSocket`). A `setMode` reply never arrives because the app relaunches first, so race it with a timeout. **Never drive the real app into `live` while testing:** if `HL_AGENT_KEY_MAINNET` is configured and authorised, live mode trades real money.
- **Panel screenshots:** an Electron script loads `dist/renderer/index.html` with a stub preload, sends `buildPanelState()` snapshots, and uses `capturePage()`. **The stub must implement every `window.ptk` method the panel calls** (`onState`, `onSound`, `command`). A missing one crashes React and renders a blank panel. A hidden window's `capturePage()` can return a stale frame after a resize, so wait ~1s and `invalidate()` first, and add `app.on('window-all-closed', () => {})` if you destroy windows between shots.

---

## 13. Gotchas

**Environment and tooling**
- **Electron 44's `clipboard.readText()` is async** (returns a Promise). Older docs show it synchronous.
- `.npmrc` has `ignore-scripts=true` and `save-exact=true`. Electron's binary therefore isn't downloaded by `npm install`; use `npm run setup` or `npx install-electron --no`. Install new packages pinned (`pkg@x.y.z`) and keep the lockfile committed.
- `@nktkas/hyperliquid` (pinned 0.33.3) is single-maintainer and pre-1.0. Its signing code was audited: it never touches the raw key and only calls Hyperliquid endpoints. Re-audit before upgrading, then re-test on testnet. It requires Node ≥ 22.12. `viem` (2.57.2) holds the key (`privateKeyToAccount`).
- Shell is Git Bash on Windows; expect the CRLF warnings on commit. They're harmless.
- **AI assistants:** deny them read and write access to `.env*` (e.g. in Claude Code permissions). To check the key, load it in a node process and print only the derived public address (`privateKeyToAccount(key).address`). **Never print the key.**
- **AI assistants:** when patching files with `node -` heredoc scripts containing JS template literals, **regex backslashes get eaten** (`/\.$/` became `/.$/`; `/^[\w.-]+\.(mp3)$/` lost its escapes). This happened four times. Use the Edit tool for any line containing a regex or escape, and run the tests after every patch.

**Behaviour**
- Content already on the clipboard at launch is deliberately stale. Copying the **same** string again doesn't reset the age, because the watcher only sees changes. This is a known limitation, listed as an open decision in `PLAN.md`.
- **Another app may already own a hotkey** (PowerToys and Steam commonly grab combos like Ctrl+Shift+X). Pick a different one in `config.json` if registration fails. Global shortcuts take keys from **every** app while the tool runs (e.g. `Ctrl+0` also takes over Chrome's reset-zoom).
- Hotkey failures show as a red alert on the panel. The terminal also logs `[hotkey] … FAILED`.
- The ready light and the press share `validate()`. **Never add a press-only refusal without adding it to the gate,** or the panel will show green while a press is refused. This is why "Orders enabled" became gate check 0.
- `LIVE_ENABLED` in `gate.js` is the kill switch. Set it `false` to refuse every live press.
- Shutdown: the 5Hz panel push must stop before the window is destroyed (`before-quit`, window `close`, `render-process-gone`), otherwise Electron logs "Render frame was disposed".
- `buildPanelState` output must survive `JSON.parse(JSON.stringify(x))` unchanged (tested), so no `Infinity` or functions.
- The fill-to-flat window in the auto-flatten path is several seconds at testnet latency (one retry plus settle delays). It only happens in the failure path.

---

## 14. Corrections to the spec

These are already applied in the code. Details are in `PLAN.md`.

1. Liquidation at 20x is about 3.75%, not 5%, so `maxStopDistancePct` is 0.03, and there's a liquidation check with a 1.2× buffer.
2. Hyperliquid has no tick size. Prices follow sig-fig and decimal rules; lot size comes from `szDecimals`.
3. There are no true market orders. "Market" means IOC with a wide limit, and stop-markets carry a worst-case limit.
4. `accountAddress` (main wallet, public) is required for info queries.
5. Leverage is read with `activeAssetData` (works while flat).
6. Cloids are 16-byte hex.
7. Unified accounts: equity comes from spot USDC.
8. Check 12 is measured from the keypress, then re-checked just before send.
9. The journal appends on close rather than writing on fill and updating.
