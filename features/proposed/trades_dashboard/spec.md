# Feature: Trades dashboard (calendar)

**Status:** built 2026-10-05. Checked against the real Notion data in a dashboard-only harness; not yet run inside the full app.
**Effort:** about 3 days including the window refactor, tests and a manual pass.
**Goal:** see results by day, week and month in R or $, before or after fees, using the trades already in the Notion **Trades** database. `example.png` is the visual reference.

---

## Decisions

| Decision | Status |
|---|---|
| Opened from the **☰ menu** ("Trades dashboard"), in a **separate window** | **Decided** |
| Data comes from the **Notion Trades database**, not `trades.csv` (Notion also holds Setup, Entry and Demon for later breakdowns) | **Decided** |
| Only rows with **Missed unticked** and Trade Outcome ≠ **Open** | **Decided** |
| Values: **R** (default) or **$**, toggled | **Decided** |
| Fees: **gross** = fees ignored (default), **net** = fees taken off, toggled | **Decided** by the trader |
| Weeks start on **Monday** | **Decided** |
| Days are the **PC's local time** (Notion returns UTC, so dates are converted) | **Decided** |
| No emotion meter | **Decided** |
| UI built with **shadcn/ui** (Tailwind), only in the dashboard window. The trade ticket keeps its plain CSS | **Decided** |
| The Notion token stays in the main process. The window asks for trades over IPC and never sees the token | **Decided** |
| The app becomes **multi-window** (window manager, one preload per window, Vite multi-page) as step 1, so screeners and a news feed can be added later | **Decided** |
| Stat cards: Net (R/$), Win %, Trade count, Green-day streak | **Proposed, needs confirming** |
| Period buttons: This Month, Last Month, Last Quarter, Last Year, All | **Proposed, needs confirming** |
| Search | **Out of v1** (nothing to search yet; revisit once Setup/Demon names are readable) |

---

## What the window shows

### Header
- Period buttons (see Decisions) and the two toggles: **R / $** and **Gross / Net**.
- Refresh button with "updated hh:mm" next to it.

### Stat cards (for the selected period)
- **Net:** total R or $, following both toggles, with a small cumulative line.
- **Win %:** wins ÷ (wins + losses). BE (|R| < 0.1, the same band as the Notion sync) is left out of both.
- **Trades:** count.
- **Green-day streak:** consecutive trading days ending today (or the period's last trading day) with a positive total. Days with no trades don't break the streak.

Win/loss/BE follow the **shown** figure: in Gross mode a trade that is +0.3R gross and −0.6R net counts as a win. In Net mode it's a loss, matching Notion's Trade Outcome.

### Monthly view (default)
- Mon–Sun grid with ‹ › to move between months, as in `example.png`.
- Each day with trades shows the **total** (R or $) and the **trade count**; green border if positive, red if negative, neutral for BE.
- A **week column** on the right: total and trade count per week.

### Weekly view
- One Mon–Sun week, ‹ › to move between weeks.
- Each day lists its trades: time, LONG/SHORT, value (R or $), plus the day total.

### Clicking a day
- A side panel lists that day's trades (time, direction, value). Each has **Open in Notion**, opened with `shell.openExternal` from the main process, which only accepts `notion.so` URLs.

---

## Data

### Read from each Notion page

| Column | Used for |
|---|---|
| Date | Which day (converted to local time) |
| Missed | Filter (unticked only) |
| Trade Outcome | Filter (not Open) |
| R Gross / R Net | R mode |
| PnL Gross / PnL Net | $ mode |
| Direction | Weekly view and day panel |
| Page URL | Open in Notion |

Rows with an empty value for the shown figure (e.g. a page created by hand with no R) are left out and counted in a small "N trades without data" note, so they aren't silently lost.

### Fetching (`notion.js`)
- New `queryTrades({ from, to })` on the existing Notion module. It reuses `request()` and the data source ID, filters in Notion on Date range, `Missed = false` and Trade Outcome ≠ Open, follows pagination (100 per page), and returns plain rows: `{ id, url, date, direction, outcome, rGross, rNet, pnlGross, pnlNet }`.
- `Missed` is added to `PROPS`, so renaming the column in Notion breaks both the sync and the dashboard, and is caught in one place.
- The read never touches the sync queue. A failed read shows "Notion unreachable — retry" in the window and has no effect on trading or syncing.

### When it refreshes
- On open, when the period changes, and on Refresh.
- Automatically after a trade's close has been written to Notion (the main process already knows when that happens).
- Results are cached per date range in the main process, and the cache is cleared on any of the above.

---

## Architecture (step 1: multi-window)

The app currently assumes one window: a single `win` global, `createWindow()`, one preload and one Vite page. The dashboard is the second window, so this is set up now, kept small, and reused by the screener and news feed later.

| File | Change |
|---|---|
| `src/main/windows.js` | **New.** `open(name)` creates or focuses a window by name. Knows each window's page, preload, size and options |
| `src/main/index.js` | The panel window, `pushPanelState`, `playSound`, `setAlwaysOnTop` and `resize` go through `windows.get('panel')`. About 40 of 182 lines, mechanical |
| `src/preloads/panel.cjs` | Today's `src/preload.cjs`, moved, contents unchanged |
| `src/preloads/dashboard.cjs` | **New.** Exposes only `getTrades(range)`, `onTradesChanged(cb)` and `openInNotion(pageId)`. No `command`, so the dashboard can't switch mode, quit or reach anything trading-related |
| `vite.config.js` | Multi-page build: the panel stays at `src/renderer/index.html`; the dashboard is `src/renderer/dashboard.html`. Tailwind is loaded only by the dashboard entry |
| `src/main/commands.js` | New `openDashboard` command (+ test) |
| `src/renderer/components/Menu.jsx` | New menu item |

**Not changed:** `actions`, `orders`, `protect`, `sizing`, `gate`, `journal`, `store`, `market`, `hotkeys`, `account`, `clipboard`.

**Dashboard window:** normal frame, resizable, not always-on-top, about 1200×800, size and position remembered. Choosing the menu item again focuses it. It closes with the app.

**Mode switch:** switching mode relaunches the app. Windows that were open before the relaunch are reopened (saved in UI prefs).

### Later (not in this feature)
- **Screeners (e.g. relative strength on Binance WebSocket) and a news feed** each run in their own Electron **utility process**, streaming to their window over a `MessagePort`. Nothing heavy or third-party runs in the trading process, so a busy feed can't delay a hotkey and a crash can't take down the process that manages the open position.
- **Screener → ticket:** wanted eventually, together with multi-coin (`../multicoin/multicoin.md`). It will be a narrow, validated command into the main process, e.g. "select coin SOL", never order placement.
- Moving the trading modules into `src/main/trading/` is tidy but changes every import and test; do it separately if wanted.

---

## Issues to watch

1. **Testnet pages:** Notion has no mode column. If `notionTestnet` is turned on for testing, those trades appear on the calendar. Delete test pages afterwards (as now), or add a Mode column if testnet syncing becomes regular.
2. **Notion rate limits** (about 3 requests/second): "All" on a large history is several paginated requests. Fine at current volume. The cache keeps repeated views cheap.
3. **Shared Setup/Entry/Demon databases:** not needed for v1. To show or filter by setup or demon later, those databases must be shared with the PTK Terminal connection (••• → Connections); until then the API returns IDs only.
4. **Gross by default** makes days look better than the account result when fees are large (≈ 77/stopDistance R per round trip). The Net toggle is one click away.

---

## Rough plan

1. Multi-window refactor: `windows.js`, preload split, Vite multi-page, reopen windows after a mode relaunch. Verify the panel is unchanged (½ day)
2. `queryTrades` in `notion.js`, IPC handler, cache, refresh after close, `openInNotion` (½ day)
3. Tailwind + shadcn in the dashboard entry; header, toggles, stat cards (½ day)
4. Monthly grid with week column, weekly view, day panel (1 day)
5. Tests (`queryTrades` mapping and filtering, local-day bucketing across midnight, week grouping, win % and streak), then a manual pass: `npm test`, launch in dry run, check the panel (state updates, sounds, always-on-top, resize) and the dashboard against the real Notion data (½ day)

No live mode during testing.

## Open questions
1. Stat cards: Net, Win %, Trades, Green-day streak. Confirm, or change the set?
2. Period buttons: This Month, Last Month, Last Quarter, Last Year, All. Confirm?
3. Is the green-day streak the right definition (consecutive positive trading days, no-trade days skipped)?
