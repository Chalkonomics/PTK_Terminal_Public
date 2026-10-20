# Hyperliquid 1m Scalp Entry Tool — Build Spec

Oct 3, 2026

## Purpose

Build a Windows desktop tool that turns a copied stop-loss price plus one hotkey into a correctly sized, stop-protected BTC position on Hyperliquid in under a second.

The trader scalps BTC perpetuals on the 1-minute chart and places orders manually in the Hyperliquid web GUI. The entry signal is visual and the stop level is structural — read off the chart, not computed. The bottleneck is everything between seeing the setup and being in the trade: opening a calculator, working out position size from the stop distance, setting leverage, typing the size, placing the entry, then placing the stop. That takes roughly thirty seconds, by which time a 1-minute setup has usually gone.

The workflow this tool enables:

1. Trader sees a setup on the Hyperliquid chart.
2. Trader right-clicks the intended stop level on the chart and copies the price. (Confirmed working — the TradingView widget returns a value such as `83,298`.)
3. Trader presses the long or short hotkey.
4. Tool reads the clipboard, validates it, computes size from a fixed 1% account risk, submits the entry, and attaches a reduce-only trigger stop at the copied price.

The stop still comes from the trader's eyes. Only the arithmetic and the clicking are automated.

**Primary design constraint:** risk per trade must be exactly 1% of account equity on every trade, with no exceptions and no post-entry adjustment. The trader is in a data-gathering phase and needs R to be a fixed unit of measurement so that setup performance can be compared across trades. A tool that is fast but produces variable R defeats its own purpose.

## Trading model

Position size is derived entirely from stop distance. The risk budget is fixed; the size floats.

```latex
\text{size (BTC)} = \frac{\text{equity} \times \text{riskPct}}{\left| \text{entry} - \text{stop} \right|}
```

Worked example with the configured defaults, assuming mark price 83,520 and a copied stop of 83,298 on a long:

| Quantity | Value |
| --- | --- |
| Account equity | 1,000 USDC |
| Risk per trade | 1% = 10 USDC |
| Stop distance | 222 USD |
| Position size | 10 / 222 = 0.045 BTC |
| Notional | 0.045 × 83,520 ≈ 3,758 USDC |
| Margin required at 20x isolated | ≈ 188 USDC |

### Leverage is static and does not affect risk

On Hyperliquid, leverage changes how much margin is locked and where liquidation sits. It does not change risk — risk is determined by size and stop distance alone. Leverage is therefore set once, manually, to 20x isolated on BTC and never touched by the tool. The tool must never call the update-leverage endpoint.

The only reason 20x matters is headroom: it must be high enough that the margin required for the largest plausible size fits in the account, and the resulting liquidation price must sit outside the stop. At 20x, liquidation is roughly 5% from entry, so any stop wider than about 4% would be unreachable. This is checked per trade (see Validation gate).

### Minimum stop distance

A very tight stop produces a very large position. At a 40-point stop the size would be 0.25 BTC — roughly 21,000 USDC notional, needing more margin than the account holds at 20x. Rather than silently capping size (which would break the fixed-1% rule) or raising leverage (which would make the configuration non-static), the tool refuses the trade and says why. The minimum stop distance is a configured value, defaulting to 80 USD.

### Stops are not moved

Because size is computed from stop distance, moving the stop after entry silently changes R. Widening a 100-point stop to 180 turns a 10 USDC risk into 18 USDC — a 1.8R position labelled 1R. The trader has decided against post-entry resizing, so the corresponding discipline is that the stop is left where the tool places it. The tool does not provide any stop-adjustment function, and this is deliberate.

Exits on the winning side are manual and out of scope for this tool. The trade resolves either at the stop or at a manual exit in the GUI.

## Architecture

&#91;embedded content: architecture · 9 components, 3 bands\]

Everything runs in one Electron app on Windows. The main process owns the clipboard watcher, the hotkeys, the validation gate and the order manager; the renderer draws the status panel and holds no logic of its own.

**Why Electron rather than plain Node.** The two awkward pieces — capturing a keypress while focus is in Chrome, and reading the clipboard — are both built-in Electron APIs (`globalShortcut`, `clipboard`). Plain Node needs `node-global-key-listener`, which shells out to a bundled platform helper. Electron also gives the status panel for free, and during the dry-run phase that panel is the main way the tool is evaluated.

**Why not Python.** The EIP-712 signing that Hyperliquid requires is Ethereum-native, and that tooling is strongest in JavaScript. There is no part of this that JavaScript does worse.

### Dependencies

| Package | Role |
| --- | --- |
| `electron` | App shell, `globalShortcut`, `clipboard`, always-on-top panel |
| `@nktkas/hyperliquid` | Info, exchange and WebSocket client |
| `viem` | EIP-712 typed-data signing beneath the SDK |
| `dotenv` | Reads the API wallet key from `.env` |

Node 20 or later. No build step beyond what Electron requires.

### Footprint

Roughly 100–200MB of RAM across processes and effectively zero CPU: a 250ms clipboard read, an idle OS-level hotkey listener, and a panel repainting a few times a second. The Hyperliquid tab already open in Chrome is doing considerably more. Devtools should not be left open in a live session, as that roughly doubles the footprint.

Latency from keypress to signed order hitting the API is a handful of milliseconds of local work plus the network round trip. The network is the whole story.

## Configuration

All tunables live in a single `config.json` outside source control, with the API wallet key read from a `.env` file that is gitignored. No secret is ever written to the log, the panel, or the console.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `dryRun` | `dryRun` \| `testnet` \| `live`. Governs whether orders are actually sent and which base URL is used. |
| `symbol` | `BTC` | Single market. The tool is deliberately BTC-only. |
| `equitySource` | `api` | `api` reads account value from Hyperliquid each trade; `fixed` uses `equityFixed`. |
| `equityFixed` | `1000` | USDC. Used only when `equitySource` is `fixed`. |
| `riskPct` | `0.01` | Fraction of equity risked per trade. |
| `leverage` | `20` | Expected isolated leverage. The tool reads and verifies this; it never sets it. |
| `minStopDistance` | `80` | USD. Below this, the trade is refused. |
| `maxStopDistancePct` | `0.04` | Fraction of mark. Above this, the trade is refused (liquidation risk). |
| `minStopDistancePct` | `0.0005` | Fraction of mark. Guards against a stop effectively at market. |
| `clipboardMaxAgeMs` | `90000` | Stop price older than this is treated as stale and refused. |
| `clipboardPollMs` | `250` | Clipboard polling interval. |
| `entryOrderType` | `marketableLimit` | `market` \| `marketableLimit`. See Order placement. |
| `marketableLimitOffsetBps` | `5` | Basis points through the mark for a marketable limit. |
| `maxSlippageBps` | `10` | Abort if mark has moved more than this between validation and submission. |
| `hotkeyLong` | `Ctrl+Shift+Up` | Global shortcut for a long. |
| `hotkeyShort` | `Ctrl+Shift+Down` | Global shortcut for a short. |
| `hotkeyPanic` | `Ctrl+Shift+X` | Flatten BTC and cancel all BTC orders. |
| `setupLabels` | `["A","B","C"]` | Optional tags selectable in the panel before firing. |
| `logPath` | `./trades.csv` | Trade journal location. |

### Defaults carried from the design discussion

The account is 1,000 USDC, risk is 1%, the market is BTC only, leverage is 20x isolated, minimum stop distance is 80 USD, maximum stop distance is 4% of mark, and clipboard staleness is capped at 90 seconds. These are the agreed starting values; all are configurable.

## Clipboard watcher

The clipboard is the stop-price channel. It carries no timestamp of its own, so the watcher supplies one.

A background interval calls Electron's `clipboard.readText()` every `clipboardPollMs` (default 250ms). When the string differs from the previous read, the watcher stores the new string and records `Date.now()` as its capture time. That timestamp is what the staleness check later tests against. The read is synchronous and cheap, but Windows can briefly lock the clipboard while another process writes to it, so every read is wrapped in try/catch and a failed tick is skipped rather than allowed to kill the watcher.

### Parsing rules

The observed clipboard format from the Hyperliquid chart is `83,298` — comma as a thousands separator, rounded to the nearest whole dollar. Parsing must be strict rather than permissive.

1. Trim whitespace. Reject anything longer than 24 characters.
2. Reject if the string contains any character outside `[0-9,. ]`. This drops URLs, tickers, and arbitrary copied text immediately.
3. Strip spaces and commas. **Do not** attempt locale-aware decimal handling.
4. Reject if more than one `.` remains.
5. Parse to a float. Reject `NaN`, zero, and negatives.

> **Known hazard.** The string `83,298` parses to `83.298` under a comma-as-decimal locale. That would be read as a stop 83,000 USD away and produce an absurdly small size — or, if interpreted the other way on a different value, an absurdly large one. Stripping commas unconditionally is correct here because the source format is known. The magnitude sanity check in the validation gate is the backstop: a parsed stop that is not within a plausible band of the live mark is refused regardless of how it parsed.

Rounding to the nearest dollar is acceptable. On an \~83,000 USD instrument with a stop a few hundred wide, a dollar of imprecision moves actual risk by well under 1% of the risk budget.

### What the watcher exposes

A single object, read by the hotkey handler at press time: the raw string, the parsed numeric value or `null`, the capture timestamp, and the derived age in milliseconds. The panel renders all of these live.

## Hotkeys

Registered through Electron's `globalShortcut` in the main process, so they fire while focus is in Chrome — which is the whole point.

| Action | Default combo |
| --- | --- |
| Long | `Ctrl+Shift+Up` |
| Short | `Ctrl+Shift+Down` |
| Panic flatten | `Ctrl+Shift+X` |

Function keys were considered and rejected. F1 opens browser help and F12 opens devtools, and more importantly a bare function key means one accidental press sends a live leveraged order. A three-key modifier combo is effectively impossible to hit by accident and is not claimed by Chrome.

### Registration

`globalShortcut.register()` returns `false` when another application already owns the combo — it does not throw. The return value must be checked at startup for every shortcut, and any failure surfaced on the panel as a persistent error state. Discovering a dead hotkey mid-setup is the failure this prevents. Overlay applications (Steam, Discord, GeForce Experience) are the usual culprits.

All shortcuts are unregistered on app quit.

### Windows-specific behaviour

No accessibility permissions are required, unlike macOS. The one real gotcha is integrity-level mismatch: if Chrome runs elevated and the Electron app does not, Windows UIPI blocks delivery of the keypress to the lower-integrity process. The symptom is a hotkey that works everywhere except over the browser. Neither process should normally be elevated; if the symptom appears, this is the cause.

### Direction inference as a cross-check

The stop's position relative to the live mark already implies direction: below mark means long, above means short. Rather than collapsing to a single key, the tool keeps two keys and treats a mismatch as a hard error. Pressing the long key with a stop above the mark means either the wrong key was pressed or the wrong level was copied. Either way the trade must not go through.

## Validation gate

Every check runs in order on hotkey press. The first failure aborts: nothing is sent, an error sound plays, and the panel shows which check failed and the offending value. There is no override and no confirmation dialog — a dialog would reintroduce the latency the tool exists to remove.

1. **Mode and connection.** API client is initialised, WebSocket is connected, and a mark price has been received within the last 5 seconds. A stale mark means the sizing input is unreliable.
2. **No open position.** Query current BTC position. If any size is open, refuse. This prevents accidentally doubling risk by firing twice, which is the classic way these tools hurt people. The trader must flatten first.
3. **No resting BTC orders.** A leftover trigger or unfilled limit from a previous attempt would interact unpredictably. Refuse if any exist.
4. **Clipboard parses.** A numeric value was successfully extracted per the parsing rules.
5. **Clipboard is fresh.** Age is at most `clipboardMaxAgeMs` (90s). This is the stale-stop guard — the trader lines up a setup, gets distracted, returns and fires without re-copying.
6. **Magnitude is plausible.** The parsed stop is within ±10% of the live mark. Catches locale mis-parses and prices copied from a different instrument.
7. **Correct side of mark.** Stop below mark for a long, above mark for a short. A mismatch means wrong key or wrong level.
8. **Distance within band.** `|mark − stop|` is at least `minStopDistance` (80 USD) and at least `minStopDistancePct`, and at most `maxStopDistancePct` (4%) of mark.
9. **Computed size is valid.** Size is greater than zero after rounding to the market's lot size, and notional meets Hyperliquid's minimum order value.
10. **Margin is available.** Required margin at the configured leverage is at most 80% of free collateral.
11. **Liquidation sits outside the stop.** Estimated liquidation price is further from entry than the stop, with margin to spare. If the stop would be unreachable, the trade is meaningless.
12. **Mark has not moved.** Immediately before submission, re-read the mark. If it has moved more than `maxSlippageBps` since the size was computed, abort and recompute rather than send a stale size.

In combination, checks 4 through 8 make a stale clipboard value almost impossible to act on: BTC on a 1-minute chart does not sit still long enough for a price copied minutes ago to remain both fresh-looking and on the correct side at a plausible distance.

### Rounding

Size must be rounded **down** to the market's lot size, and the stop trigger price rounded to the market's tick size, both fetched from the `meta` info endpoint at startup rather than hard-coded. Rounding size down keeps actual risk at or just under 1%; rounding up would breach it. An order violating tick or lot constraints is rejected outright by the exchange.

## Order placement

The stop must exist on the exchange, not in the script. A locally managed stop silently ceases to exist if the process dies, the laptop sleeps, or the connection drops — leaving an unstopped leveraged position. The entry and the reduce-only trigger are therefore submitted together in a single signed action.

### Entry order type

Default is a **marketable limit**: a limit order priced `marketableLimitOffsetBps` (5bp) through the mark, with IOC time-in-force. It fills immediately in normal conditions but cannot be filled at an absurd price during a spike. A pure market order is available via config for comparison.

The trade-off is that a marketable limit occasionally does not fill, which on a 1-minute scalp means a missed trade. That is the correct failure direction: a missed trade costs nothing, a 50-point slippage fill on a 10 USDC risk budget costs a meaningful fraction of R. Both behaviours should be logged so the choice can be reviewed against real fills.

### Stop order

A reduce-only trigger (stop-market) at the validated stop price, sized to the full position. Reduce-only guarantees it can only close, never open or flip.

### Failure handling

This is the part that must not be skimped.

- **Entry rejected.** Nothing happened. Report and stop.
- **Entry filled, stop accepted.** Normal path. Log and update the panel.
- **Entry filled, stop rejected or errored.** The dangerous state. Retry the stop once immediately. If it fails again, **flatten the position at market** and report loudly. An unstopped position is never left open, under any circumstance, including an unclear or timed-out response.
- **Response ambiguous or request timed out.** Do not assume failure and do not retry the entry. Query actual position state from the exchange, reconcile against intent, and either attach the missing stop or flatten.

### Panic key

`Ctrl+Shift+X` cancels all resting BTC orders and market-closes any open BTC position. It requires no clipboard value and runs regardless of validation state. This exists so that a confused state always has a single-keystroke exit.

### Order submission must be idempotent per press

A held or repeated keypress must not produce two orders. Each press takes a lock that is released only when the full sequence has resolved; presses arriving while locked are ignored and noted on the panel. Hyperliquid's client order ID should also be set per attempt so a retried submission cannot double-fill.

## Status panel

A small always-on-top, frameless window positioned beside the browser. During the dry-run phase this panel is effectively the product: the trader glances at it and sees instantly whether the tool agrees with the trade they are about to take.

Displayed at all times:

| Field | Notes |
| --- | --- |
| Mode | `DRY RUN` / `TESTNET` / `LIVE`, colour-coded. Live is unmistakable. |
| Mark price | Live from WebSocket. |
| Clipboard stop | Parsed value, or the raw string in red if unparseable. |
| Stop age | Seconds, turning amber past 60s and red past 90s. |
| Implied direction | Long or short, derived from stop vs mark. |
| Stop distance | In USD and as a percentage of mark. |
| Computed size | BTC, after lot rounding. |
| Notional and margin | USDC. |
| Risk | USD and as a percentage of equity — should always read 1.00%. |
| Ready indicator | Green, amber or red (below). |
| Position | Current BTC size, entry, live PnL, and whether a stop is attached. |
| Setup label | Selector for the active tag, written to the log on the next fire. |
| Last action | Result of the most recent press, including refusal reason. |

### Ready indicator

- **Green** — all validation checks pass. A press will fire.
- **Amber** — would pass, but something needs attention: stop age over 60s, or margin usage above half of free collateral.
- **Red** — a press will be refused, with the failing check named directly on the panel.

The indicator is computed continuously from the same validation code path that runs on press, not a separate approximation. If the two could disagree, the panel would be lying.

### Update throttling

Rendering every WebSocket tick would repaint hundreds of times per second for no benefit. The panel updates at 4–5 Hz, which is imperceptibly different on a chart being read by a human and keeps CPU at effectively zero.

### Audio feedback

Distinct short sounds for accepted, refused, and error-after-entry. The trader's eyes are on the chart, not the panel, at the moment of pressing.

## Trade logging

The log is the reason the tool exists. Speed gets the trader into the setup; the log is what tells them which setups are worth taking. One row appended per trade to `trades.csv`, written on fill and completed when the position closes.

| Column | Description |
| --- | --- |
| `tradeId` | UUID, also used as the client order ID. |
| `tsEntry` | ISO 8601, UTC. |
| `mode` | dryRun / testnet / live. |
| `setupLabel` | The tag selected on the panel. |
| `direction` | long / short. |
| `markAtPress` | Mark when the hotkey was pressed. |
| `stopPrice` | The validated clipboard value. |
| `stopDistance` | USD, and as a percentage of mark. |
| `clipboardAgeMs` | How stale the stop was when fired. |
| `intendedSize` | Before lot rounding. |
| `filledSize` | Actual. |
| `entryPrice` | Average fill. |
| `slippageBps` | Entry versus mark at press. |
| `riskUsd` | Actual dollar risk after rounding. |
| `notional`, `marginUsed` | USDC. |
| `equityAtEntry` | For reconstructing risk percentage. |
| `exitReason` | stopped / manual / panic. |
| `tsExit`, `exitPrice` | Close details. |
| `pnlUsd`, `pnlR` | Result in dollars and in R multiples. |
| `feesUsd` | Entry and exit combined. |
| `mae`, `mfe` | Maximum adverse and favourable excursion, in USD and R. |

### Why MAE and MFE matter

These two columns let the stop-placement question be answered from data rather than by experimenting with live money.

**MAE** — how far price went against the position before it resolved. If very few winners ever travelled more than, say, 70% of the way to the stop before working, the stop is wider than it needs to be and can be tightened, taking more size at the same risk. If many losers barely exceeded the stop before reversing, it is too tight.

**MFE** — how far price went in favour before the exit. On 1-minute scalps this is usually where the improvement is: it shows whether exits are leaving money on the table.

Both are tracked by sampling mark price at 1Hz while a position is open and retaining the extremes.

### Setup label

This is the column people skip and then regret. Without it, the log can only answer "does my scalping work". With it, the log answers which patterns carry the account — and the usual finding is that two of five setups produce everything and the rest bleed.

Because fees and slippage are a material fraction of a 10 USDC risk budget, `feesUsd` and `slippageBps` are not optional. Realised R should be computed net, not gross.

## Staged rollout

Three modes, promoted only when the previous one has been observed working. The mode is a config value and the panel colour-codes it so the current state is never in doubt.

**Phase 1 — Dry run.** No API client is initialised for trading; only the public info and WebSocket feeds are used. Hotkeys run the full validation gate and compute the complete order, then log and display what *would* have been sent. Nothing is signed or submitted.

Run this alongside normal manual trading for a session or two. The question being answered is not "does the code run" but "does the tool's number match what I would have done". Watch for stops it refuses that you would have taken, and sizes that look wrong against your own mental arithmetic.

**Phase 2 — Testnet.** Full order submission against `api.hyperliquid-testnet.xyz`. The faucet provides 1,000 USDC, which matches the intended live account size exactly, so sizing behaviour is directly comparable. What this phase tests is the parts dry run cannot: signing, order acceptance, trigger-stop attachment, fills, and specifically the failure paths. Deliberately provoke a rejected stop and confirm the auto-flatten fires.

**Phase 3 — Live.** Switch base URL and credentials. Start at a reduced `riskPct` — 0.25% rather than 1% — for the first 20 or so trades. Everything is identical to testnet except that mistakes cost money, and the first live session is where an unnoticed difference between testnet and mainnet behaviour will show up.

### Build order

1. Clipboard watcher, parser, and staleness clock, with console output only.
2. Info client: market metadata, tick and lot size, live mark via WebSocket.
3. Sizing and the full validation gate, as a pure function that takes a state object and returns pass/fail plus a reason. This must be unit-testable without any network.
4. Panel rendering the state object.
5. Global hotkeys wired to the gate, still dry run.
6. Signing and order submission, testnet only.
7. Failure handling and the panic key.
8. CSV logging with MAE/MFE tracking.

Step 3 is the heart of it and should have real unit tests: stale clipboard, wrong-side stop, too-tight stop, too-wide stop, comma mis-parse, zero and negative values, position already open, insufficient margin.

## Prerequisites

These are manual steps the trader must complete before first run. The tool cannot do them and should fail with a clear message if they are missing.

**Create an API wallet.** In the Hyperliquid UI under the API section, generate an agent wallet and approve it on-chain (costs a small amount of gas). This produces a private key that can place and cancel orders on behalf of the main account but **cannot withdraw funds**. That key, and only that key, goes in `.env`.

The main account's private key must never appear in this project, in any config file, or in any environment variable. There is no feature in this tool that requires it.

**Set leverage manually.** BTC to 20x isolated, once, in the GUI. The tool reads and verifies this at startup and refuses to run if it does not match `config.leverage`. It never sets leverage itself.

**Fund testnet.** The testnet faucet provides 1,000 USDC. Use it for phase 2.

**Confirm the chart copy behaviour.** Right-clicking a price level on the Hyperliquid chart copies a value such as `83,298`. This has been verified. If a future UI change alters the format, the parser's character whitelist will reject it rather than mis-read it — the panel will show the raw string in red.

### Endpoints

| Environment | REST | WebSocket |
| --- | --- | --- |
| Mainnet | `https://api.hyperliquid.xyz` | `wss://api.hyperliquid.xyz/ws` |
| Testnet | `https://api.hyperliquid-testnet.xyz` | `wss://api.hyperliquid-testnet.xyz/ws` |

Official API documentation is at [hyperliquid.gitbook.io](https://hyperliquid.gitbook.io/hyperliquid-docs) under For Developers → API.

## Non-goals, open items and limitations

### Explicitly out of scope

- **Signal generation.** The tool never decides when to trade. Entries are the trader's eyes, always.
- **Stop adjustment.** No function to move a stop after entry. This is a deliberate consequence of fixed-R sizing, not an omission.
- **Position resizing.** Rejected by the trader for the data-gathering phase.
- **Take-profit management.** Exits on the winning side are manual in the GUI.
- **Multiple markets.** BTC only. Adding markets means per-market tick, lot and minimum-notional handling, and should not be attempted until the single-market version has been traded live.
- **Multiple or pyramided positions.** The tool refuses to enter while a position is open.

### Open decisions

- **Entry order type** was left undecided in discussion. This spec defaults to marketable limit with market available in config, and both logged. Review after the first 50 testnet fills.
- **Setup labels** are listed as A/B/C placeholders. The trader should replace these with the actual pattern names being traded, since this column is what the whole log is for.
- **Equity source.** Reading live account value each trade keeps risk at a true 1% as the account grows or shrinks; a fixed figure keeps R constant in dollars across the sample. The former is defaulted, but the latter is arguably better for comparing setups over a short evaluation window.

### Known limitations

- The clipboard has no provenance. A price copied from somewhere else entirely, that happens to be near the BTC mark and on the correct side, would pass every check. The validation gate narrows this to near-impossibility but cannot eliminate it.
- Stop prices copied from the chart are rounded to whole dollars, so actual risk deviates from exactly 1% by a negligible amount.
- On a 1,000 USDC account, fees and slippage are a material fraction of a 10 USDC risk budget. Realised R will be measurably worse than theoretical R. This is a property of the account size, not a bug, but it must be accounted for when evaluating setups — which is why fees are logged.
- Electron carries a Chromium runtime, roughly 100–200MB of RAM, for a tool that does almost nothing. This is irrelevant on a machine already running Chrome but is noted for completeness.
