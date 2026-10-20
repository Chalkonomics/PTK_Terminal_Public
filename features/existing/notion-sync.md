# Feature: Notion sync

**Status:** built. Off by default; turn it on with `notionSync: true` once the Notion connection is set up (see below).
**Code:** `src/main/notion.js`, hooked in through the journal's `mirror` (`src/main/journal.js`). Tests are in `test/notion.test.js`. The technical reference is `index.md` §11.
**Goal:** every mainnet trade appears in the trader's Notion **Trades** database without manual entry. The tool writes the facts, and the trader adds their read of the trade (setup, entry, confluence, demon, notes) on the same page.

---

## How it works for the trader

1. **Entry:** the tool creates a page with the **Trade Report** template already applied (Gallery shot, Entry, Exit and Confluence sections). It's titled e.g. `BTC Long · 5 Oct 11:19`, and Trade Outcome = **Open** (a grey card in the gallery).
2. **While the trade is open:** fill in Setup, Entry, Confluence and Demon, and write notes. The tool never touches these columns or the page body.
3. **Close:** the tool fills in Trade Outcome (Win / Loss / BE), PnL Gross/Net and R Gross/Net. Notion's formulas then work out Fees, Fees R and Fee Drag.

If Notion is down, the panel shows `Notion: N update(s) waiting`. The update is sent once Notion responds, and trading is never affected.

---

## Decisions

| Decision | Status |
|---|---|
| Create the page **at entry**, update it at close (so notes can be written during the trade) | **Decided** |
| **Mainnet only.** Testnet only with `notionTestnet: true`, for testing. Dry run never. | **Decided** |
| Trade Outcome comes from **net** R (a trade that's green before fees and red after is a Loss). **BE** when \|net R\| < 0.1 | **Decided** |
| Record PnL **with and without fees**, in USD and R, to track how much fees take over time | **Decided** |
| One template (**Trade Report**, the default) for taken and missed setups; Missed is a checkbox | **Decided** |
| Setup becomes a relation to its own **Setups** database (playbook entries live there, not in Trades) | **Decided** (done by the trader in Notion) |
| No backfill command. Only trades taken while the sync is on are mirrored. | **Decided** |
| Hidden `tradeId` column links each page to its `trades.csv` row and prevents duplicates | **Decided** |
| The CSV stays the source of truth. Notion is a mirror. | **Decided** |

---

## The Trades database

| Column | Type | Filled by |
|---|---|---|
| Name (title) | title | tool, at entry |
| tradeId (hidden) | text | tool, at entry |
| Direction | select `LONG` / `SHORT` | tool, at entry |
| Date | date | tool, at entry |
| Asset | text | tool, at entry |
| Trade Outcome | select `Open` / `Win` / `Loss` / `BE` | tool (Open at entry, result at close) |
| PnL Gross, PnL Net | number ($) | tool, at close |
| R Gross, R Net | number | tool, at close |
| Fees, Fees R, Fee Drag | formula | Notion |
| Setup | relation → Setups | trader |
| Entry, Confluence | relations | trader |
| Demon | relation → Demons | trader |
| Missed | checkbox | trader |

Old columns (R:R, Valid Trade, Reference Level, Reference Timeframe, Setup Continuation) are hidden, not deleted, so past pages keep their data.

**Renaming a tool-written column breaks the sync.** The names are fixed in `PROPS` in `notion.js`. Rename both together, or ask Claude to.

---

## Setup

- Create a Notion connection (e.g. **PTK Terminal**) (Notion now calls integrations "connections"; they're created in Settings → Connections), with read, update and insert content.
- Build a Trades database with the columns above, and share it with the connection (••• → Connections).
- Put `NOTION_TOKEN` and `NOTION_DATABASE_ID` in `.env`.
- Gallery cards: the visible properties are chosen per view under ••• → Properties, and the card image under ••• → Layout → Card preview.

---

## Ideas / possible follow-ups

- Share the Setups, Entry, Confluence and Demon databases with the connection, so the tool or Claude can read them (e.g. R Net by setup).
- Rollups on the Setups database: trade count, win rate and average R Net per setup.
- Write more of the CSV into Notion if it turns out to be useful (entry/exit price, slippage, MAE/MFE, exit reason).
- Delete the old *Trade*, *Playbook Setup* and *Missed Setup* templates if they're no longer used.

---

## Log

- **2026-10-05:** designed, built and tested against a fake Notion API and a real database with a fake trade.
