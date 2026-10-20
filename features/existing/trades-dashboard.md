# Feature: Trades dashboard (calendar)

**Status:** built 2026-10-05. Checked against a real Notion database in a dashboard-only harness (figures matched the Notion pages). **Still to do:** a pass in the full app in dry run (panel unchanged, dashboard opens from the menu).
**Code:** main side in `src/main/dashboard.js`, `src/main/windows.js` and `queryTrades` in `src/main/notion.js`; preload `src/preloads/dashboard.cjs`; UI in `src/renderer/dashboard/` (page `src/renderer/dashboard.html`). Tests are in `test/calendar.test.js`, `test/windows.test.js` and `test/notion.test.js`. The technical reference is `index.md` (Windows, module map). The original spec is `features/proposed/trades_dashboard/spec.md`.
**Goal:** see results by day, week and month in R or $, before or after fees, from the trades already in the Notion **Trades** database.

---

## How it works for the trader

1. **Open it:** ☰ → **Trades dashboard**. It opens in its own window (normal frame, resizable, not always-on-top). Choosing it again brings the open window to the front. It remembers its size and position.
2. **Toggles (top right):**
   - **R / $:** R is the default.
   - **Gross / Net:** Gross = fees ignored (default), Net = fees taken off.
   - The window remembers both.
3. **Period buttons (top left):** This Month, Last Month, Last Quarter, Last Year, All. They drive the stat cards. This Month and Last Month also move the calendar to that month.
4. **Stat cards:**
   - **Net:** total for the period, with a running-total line (hover it for the value after each trade).
   - **Win %:** wins ÷ (wins + losses), with the W/L count. BE trades count for neither.
   - **Trades:** count of taken trades.
   - **Green-day streak:** consecutive positive trading days, counting back from the latest one. Days with no trades don't break it.
5. **Calendar:**
   - **Month:** Mon–Sun grid. Each trading day shows its total and trade count, with a green or red border. A **Week** column on the right shows each week's total.
   - **Week:** one Mon–Sun week with every trade listed (time, L/S, value).
   - ‹ › move by month or week; **Today** jumps back.
6. **Click a day:** a side panel lists that day's trades (time, direction, value, Win/Loss/BE). **Notion ↗** opens the trade's page in the browser.
7. **Refreshing:** it updates by itself when a trade's result lands in Notion. The ⟳ button next to "updated hh:mm" forces a fresh read. If Notion can't be reached, a banner says so, with **Retry**. Trading and the Notion sync are never affected.

---

## Decisions

| Decision | Status |
|---|---|
| Data comes from the **Notion Trades database**, not `trades.csv` (Notion also has Setup, Entry and Demon for later breakdowns) | **Decided** |
| Only **Missed unticked** and Trade Outcome **not Open** | **Decided** |
| Default view: **R, Gross** (fees ignored) | **Decided** by the trader |
| Win / Loss / BE follow the **shown** figure (Gross or Net), with the same ±0.1R BE band as the Notion sync | **Decided** |
| Days are the **PC's local time** (Notion stores UTC); weeks start **Monday** | **Decided** |
| Last Quarter / Last Year are the **previous calendar** quarter / year | **Decided** (easy to change to rolling 90 days / 12 months) |
| No emotion meter; no search in v1 | **Decided** |
| The Notion token stays in the main process. The dashboard can only read trades and open `https://` Notion links; it has no command channel | **Decided** |
| UI built with **shadcn/ui + Tailwind**, loaded only by the dashboard page. The panel keeps its plain CSS | **Decided** |

---

## Things to know

- **Testnet pages show up** if `notionTestnet` is turned on, because Notion has no mode column. Delete test pages afterwards, or add a Mode column if testnet syncing becomes regular.
- **Pages with no figure** (e.g. made by hand with R Net empty) aren't counted in totals. The Net card says "N trades without data", so they aren't silently lost.
- **Renaming a column in Notion** breaks the dashboard as well as the sync. The names are in `PROPS` in `notion.js` (the dashboard also reads **Missed** and **Direction**).
- **Mode switch:** the app relaunches; if the dashboard was open, it comes back.
- **shadcn components** live in `src/renderer/dashboard/components/ui/`. To add one: `npx shadcn@latest add <name>`, then check its imports use `@/lib/utils` — on 2026-10-05 the CLI rewrote them to an unrelated npm package called `cn` and installed it. That package was removed.

---

## Ideas / possible follow-ups

- Breakdowns by **Setup** or **Demon** (needs those databases shared with the PTK Terminal connection, ••• → Connections).
- Rolling periods (last 90 days / 12 months) instead of calendar quarter / year.
- Search or filters (direction, setup) once Setup and Demon names are readable.
- Average R per trade, best / worst day, and max drawdown in R on the stat cards.

---

## Log

- **2026-10-05:** spec reviewed and rewritten with the trader; the app made multi-window (window manager, one preload per window, Vite multi-page); dashboard built and checked against the real Notion data in a harness. 234 tests pass.
