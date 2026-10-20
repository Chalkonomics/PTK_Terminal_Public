import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeProperties, createNotionSync, entryProperties, loadNotionEnv, outcomeFor, PROPS, syncsMode, tradeFromPage, tradesFilter, tradeTitle } from '../src/main/notion.js';
import { createJournal } from '../src/main/journal.js';
import { DEFAULTS } from '../src/main/config.js';

const CONFIG = { ...DEFAULTS, notionSync: true };
const ENV = { token: 'ntn_test', databaseId: 'db1' };
const OPENED = { tradeId: '0xabc', coin: 'BTC', direction: 'long', tsEntry: Date.UTC(2026, 9, 14, 13, 42, 17), mode: 'live' };
// A made-up closed trade.
const ROW = { tradeId: '0xabc', tsEntry: '2026-10-14T13:42:17.250Z', mode: 'live', direction: 'long', plannedRiskUsd: 10, pnlUsd: 15.312, pnlR: 1.5312, feesUsd: 4.688 };

function memFs() {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, d) => files.set(p, String(d)),
    unlinkSync: (p) => files.delete(p),
  };
}

/** A stand-in for the Notion API: one data source, pages keyed by tradeId. */
function fakeNotion() {
  const pages = new Map();
  const calls = [];
  const state = { failNext: 0, status: 503, dashboardPages: [], pageSize: 100 };
  const reply = (status, body, headers = {}) => ({ ok: status < 300, status, statusText: '', headers: { get: (h) => headers[h] ?? null }, json: async () => body });
  const fetch = async (url, { method, headers, body }) => {
    const endpoint = url.replace('https://api.notion.com/v1/', '');
    const json = body ? JSON.parse(body) : null;
    calls.push({ method, endpoint, body: json, headers });
    if (state.failNext > 0) {
      state.failNext -= 1;
      return reply(state.status, { code: 'service_unavailable', message: 'down' }, state.status === 429 ? { 'retry-after': '30' } : {});
    }
    if (method === 'GET' && endpoint === 'databases/db1') return reply(200, { data_sources: [{ id: 'ds1' }] });
    if (method === 'POST' && endpoint === 'data_sources/ds1/query' && json.filter.and) {
      // The dashboard's query: pages served in chunks to exercise pagination.
      const start = Number(json.start_cursor ?? 0);
      const end = start + state.pageSize;
      const more = end < state.dashboardPages.length;
      return reply(200, { results: state.dashboardPages.slice(start, end), has_more: more, next_cursor: more ? String(end) : null });
    }
    if (method === 'POST' && endpoint === 'data_sources/ds1/query') {
      const id = json.filter.rich_text.equals;
      const page = [...pages.values()].find((p) => p.properties[PROPS.tradeId].rich_text[0].text.content === id && !p.in_trash);
      return reply(200, { results: page ? [page] : [] });
    }
    if (method === 'POST' && endpoint === 'pages') {
      const page = { id: `page${pages.size + 1}`, properties: json.properties, template: json.template, parent: json.parent };
      pages.set(page.id, page);
      return reply(200, page);
    }
    if (method === 'PATCH' && endpoint.startsWith('pages/')) {
      const page = pages.get(endpoint.slice(6));
      Object.assign(page.properties, json.properties ?? {});
      if (json.in_trash) page.in_trash = true;
      return reply(200, page);
    }
    return reply(404, { code: 'object_not_found', message: endpoint });
  };
  return { fetch, pages, calls, state };
}

function syncWith({ config = CONFIG, env = ENV, notion = fakeNotion(), fs = memFs(), onWrite } = {}) {
  const time = { now: 1_000_000 };
  const sync = createNotionSync({ config, rootDir: 'C:/j', env, fetch: notion.fetch, log: () => {}, now: () => time.now, fs, timeZone: 'UTC', onWrite });
  // Runs ticks until the queue is empty or stuck waiting on a retry.
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      sync.tick();
      while (sync.sending) await new Promise((r) => setImmediate(r));
      if (!sync.status()?.pending || time.now < nextAt()) return;
    }
  };
  const nextAt = () => JSON.parse(fs.files.get('C:\\j\\notion-pending.json') ?? fs.files.get('C:/j/notion-pending.json') ?? '[{"nextAt":0}]')[0].nextAt;
  return { sync, notion, fs, time, drain };
}

const prop = (page, name) => {
  const p = page.properties[name];
  return p.title?.[0].text.content ?? p.rich_text?.[0].text.content ?? p.select?.name ?? p.date?.start ?? p.number;
};

// ---- pure ----

test('mainnet only, unless the testnet switch is on', () => {
  assert.equal(syncsMode(CONFIG, 'live'), true);
  assert.equal(syncsMode(CONFIG, 'testnet'), false);
  assert.equal(syncsMode(CONFIG, 'dryRun'), false);
  assert.equal(syncsMode({ ...CONFIG, notionTestnet: true }, 'testnet'), true);
  assert.equal(syncsMode({ ...CONFIG, notionSync: false }, 'live'), false);
});

test('outcome from net R with a breakeven band', () => {
  assert.equal(outcomeFor(1.53), 'Win');
  assert.equal(outcomeFor(-1.27), 'Loss');
  assert.equal(outcomeFor(0.05), 'BE');
  assert.equal(outcomeFor(-0.09), 'BE');
});

test('title and entry columns', () => {
  assert.equal(tradeTitle(OPENED, 'UTC'), 'BTC Long · 14 Oct 13:42');
  assert.equal(tradeTitle({ ...OPENED, direction: 'short' }, 'Europe/Paris'), 'BTC Short · 14 Oct 15:42');
  const p = entryProperties(OPENED, 'UTC');
  assert.equal(p[PROPS.direction].select.name, 'LONG');
  assert.equal(p[PROPS.outcome].select.name, 'Open');
  assert.equal(p[PROPS.tradeId].rich_text[0].text.content, '0xabc');
  assert.equal(p[PROPS.date].date.start, '2026-10-14T13:42:17.000Z');
  assert.deepEqual(entryProperties({ ...ROW, coin: 'BTC' }, 'UTC')[PROPS.title], p[PROPS.title], 'a CSV row gives the same title');
});

test('close columns: gross adds fees back, both in USD and R', () => {
  const p = closeProperties(ROW);
  assert.equal(p[PROPS.outcome].select.name, 'Win');
  assert.equal(p[PROPS.pnlNet].number, 15.31);
  assert.equal(p[PROPS.pnlGross].number, 20);
  assert.equal(p[PROPS.rNet].number, 1.53);
  assert.equal(p[PROPS.rGross].number, 2);
});

test('env: reads both values, never throws', () => {
  const fs = memFs();
  assert.deepEqual(loadNotionEnv('C:/j', fs), { token: null, databaseId: null });
  fs.files.set('C:\\j\\.env', 'HL_AGENT_KEY_MAINNET=0x1\nNOTION_TOKEN= ntn_x \nNOTION_DATABASE_ID=abc\n');
  fs.files.set('C:/j/.env', fs.files.get('C:\\j\\.env'));
  assert.deepEqual(loadNotionEnv('C:/j', fs), { token: 'ntn_x', databaseId: 'abc' });
});

// ---- sync ----

test('entry creates a page from the default template; close updates the same page', async () => {
  const { sync, notion, drain } = syncWith();
  sync.tradeOpened(OPENED);
  await drain();
  assert.equal(notion.pages.size, 1);
  const page = notion.pages.get('page1');
  assert.deepEqual(page.template, { type: 'default', timezone: 'UTC' });
  assert.deepEqual(page.parent, { type: 'data_source_id', data_source_id: 'ds1' });
  assert.equal(prop(page, PROPS.outcome), 'Open');
  assert.equal(notion.calls[0].headers.Authorization, 'Bearer ntn_test');

  sync.tradeClosed(ROW);
  await drain();
  assert.equal(notion.pages.size, 1, 'no second page');
  assert.equal(prop(page, PROPS.outcome), 'Win');
  assert.equal(prop(page, PROPS.pnlNet), 15.31);
  assert.equal(prop(page, PROPS.title), 'BTC Long · 14 Oct 13:42', 'close leaves the title alone');
  assert.deepEqual(sync.status(), { pending: 0, error: null });
});

test('testnet and dry-run trades are not sent', async () => {
  const { sync, notion, drain } = syncWith();
  sync.tradeOpened({ ...OPENED, mode: 'testnet' });
  sync.tradeClosed({ ...ROW, mode: 'testnet' });
  await drain();
  assert.equal(notion.calls.length, 0);
  assert.equal(sync.status().pending, 0);
});

test('Notion down: queued, shown, retried with backoff, then sent', async () => {
  const { sync, notion, time, drain } = syncWith();
  notion.state.failNext = 1;
  sync.tradeOpened(OPENED);
  await drain();
  assert.equal(notion.pages.size, 0);
  assert.equal(sync.status().pending, 1);
  assert.match(sync.status().error, /503/);

  time.now += 4000;
  await drain();
  assert.equal(notion.pages.size, 0, 'waits out the backoff');
  time.now += 1000;
  await drain();
  assert.equal(notion.pages.size, 1);
  assert.deepEqual(sync.status(), { pending: 0, error: null });
});

test('rate limited: honours Retry-After', async () => {
  const { sync, notion, time, drain } = syncWith();
  notion.state.failNext = 1;
  notion.state.status = 429;
  sync.tradeOpened(OPENED);
  await drain();
  time.now += 29_000;
  await drain();
  assert.equal(notion.pages.size, 0);
  time.now += 1000;
  await drain();
  assert.equal(notion.pages.size, 1);
});

test('a retry after a create that actually landed does not duplicate', async () => {
  const { sync, notion, time, drain } = syncWith();
  sync.tradeOpened(OPENED);
  await drain();
  // Same trade queued again, as if the first attempt had timed out after Notion stored it.
  sync.tradeOpened(OPENED);
  time.now += 10_000;
  await drain();
  assert.equal(notion.pages.size, 1);
});

test('close while the entry is still queued: one page with everything', async () => {
  const { sync, notion, drain } = syncWith();
  sync.tradeOpened(OPENED);
  sync.tradeClosed(ROW);
  assert.equal(sync.status().pending, 1, 'merged into one job');
  await drain();
  assert.equal(notion.pages.size, 1);
  const page = notion.pages.get('page1');
  assert.equal(prop(page, PROPS.outcome), 'Win');
  assert.equal(prop(page, PROPS.direction), 'LONG');
});

test('entry never landed: the close creates the full page', async () => {
  const { sync, notion, time, drain } = syncWith();
  notion.state.failNext = 1;
  sync.tradeOpened(OPENED);
  await drain();
  sync.tradeClosed(ROW); // the entry job is mid-retry, so this queues behind it
  assert.equal(sync.status().pending, 2);
  time.now += 5000;
  await drain();
  assert.equal(notion.pages.size, 1);
  assert.equal(prop(notion.pages.get('page1'), PROPS.outcome), 'Win');
});

test('discarded trade: the entry page goes to the bin', async () => {
  const { sync, notion, drain } = syncWith();
  sync.tradeOpened(OPENED);
  await drain();
  sync.tradeDiscarded(OPENED);
  await drain();
  assert.equal(notion.pages.get('page1').in_trash, true);
});

test('queue survives a restart', async () => {
  const fs = memFs();
  const notion = fakeNotion();
  notion.state.failNext = 1;
  const first = syncWith({ fs, notion });
  first.sync.tradeOpened(OPENED);
  await first.drain();
  assert.equal(first.sync.status().pending, 1);

  const second = syncWith({ fs, notion });
  assert.equal(second.sync.status().pending, 1);
  second.time.now += 10_000;
  await second.drain();
  assert.equal(notion.pages.size, 1);
  assert.equal(second.sync.status().pending, 0);
});

test('missing .env values: nothing sent, error shown, trades kept', async () => {
  const { sync, notion, drain } = syncWith({ env: { token: null, databaseId: 'db1' } });
  sync.tradeOpened(OPENED);
  await drain();
  assert.equal(notion.calls.length, 0);
  assert.deepEqual(sync.status(), { pending: 1, error: 'NOTION_TOKEN or NOTION_DATABASE_ID missing from .env' });
});

test('sync off: no status on the panel', () => {
  const { sync } = syncWith({ config: { ...CONFIG, notionSync: false } });
  assert.equal(sync.status(), null);
});

// ---- journal -> mirror ----

test('journal tells the mirror about opens and closes, and survives it throwing', async () => {
  const fs = memFs();
  fs.appendFileSync = (p, d) => fs.files.set(p, (fs.files.get(p) ?? '') + d);
  fs.statSync = (p) => ({ size: (fs.files.get(p) ?? '').length });
  const events = [];
  const mirror = {
    tradeOpened: (r) => events.push(['opened', r.tradeId, r.mode]),
    tradeClosed: (r) => {
      events.push(['closed', r.tradeId]);
      throw new Error('boom');
    },
    tradeDiscarded: () => events.push(['discarded']),
  };
  const fill = (dir, px, time) => ({ coin: 'BTC', px: String(px), sz: '0.01', dir, closedPnl: dir.startsWith('Close') ? '1' : '0', oid: 1, fee: '0.1', feeToken: 'USDC', time });
  const j = createJournal({
    config: { ...DEFAULTS, mode: 'live', logPath: 'C:/j/trades.csv' },
    rootDir: 'C:/j',
    marketSnapshot: () => ({ mark: 85_000, account: { position: null } }),
    fetchFills: async () => [fill('Open Long', 85_000, 1_000_000), fill('Close Long', 85_100, 1_060_000)],
    log: () => {},
    now: () => 2_000_000,
    fs,
    mirror,
  });
  const plan = { direction: 'long', stopPx: 84_800, stopDistance: 200, stopDistancePct: 0.0023, size: 0.01, riskUsd: 2, equity: 1000 };
  j.openTrade({ tradeId: '0xabc', tsEntry: 1_000_000, plan, markAtPress: 85_000, clipboardAgeMs: 100, setupLabel: 'A', outcome: 'protected', stopOid: 1 });
  j.tick();
  while (j.finalizing) await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, [['opened', '0xabc', 'live'], ['closed', '0xabc']]);
  assert.match(fs.files.get('C:/j/trades.csv'), /0xabc/, 'the CSV row is written regardless');
});

// --- Trades dashboard reads ---

/** A page as the Notion API returns it, with the columns the dashboard reads. */
function apiPage(id, { date = '2026-10-14T13:42:00.000Z', outcome = 'Win', rGross = 2, rNet = 1.53, pnlGross = 20, pnlNet = 15.31 } = {}) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    properties: {
      [PROPS.title]: { title: [{ plain_text: 'BTC Long · 14 Oct 15:42' }] },
      [PROPS.date]: { date: date && { start: date } },
      [PROPS.direction]: { select: { name: 'LONG' } },
      [PROPS.outcome]: { select: { name: outcome } },
      [PROPS.rGross]: { number: rGross },
      [PROPS.rNet]: { number: rNet },
      [PROPS.pnlGross]: { number: pnlGross },
      [PROPS.pnlNet]: { number: pnlNet },
    },
  };
}

test('the dashboard filter keeps taken, closed trades in the date range', () => {
  assert.deepEqual(tradesFilter({ from: null, to: null }), [
    { property: 'Missed', checkbox: { equals: false } },
    { property: 'Trade Outcome', select: { does_not_equal: 'Open' } },
  ]);
  const f = tradesFilter({ from: '2026-09-30T23:00:00.000Z', to: '2026-10-31T23:00:00.000Z' });
  assert.deepEqual(f.slice(2), [
    { property: 'Date', date: { on_or_after: '2026-09-30T23:00:00.000Z' } },
    { property: 'Date', date: { before: '2026-10-31T23:00:00.000Z' } },
  ]);
});

test('a page maps to a plain row; empty numbers stay null; no date means no row', () => {
  assert.deepEqual(tradeFromPage(apiPage('p1')), {
    id: 'p1', url: 'https://www.notion.so/p1', title: 'BTC Long · 14 Oct 15:42', date: '2026-10-14T13:42:00.000Z',
    direction: 'LONG', outcome: 'Win', rGross: 2, rNet: 1.53, pnlGross: 20, pnlNet: 15.31,
  });
  assert.equal(tradeFromPage(apiPage('p2', { rNet: null })).rNet, null);
  assert.equal(tradeFromPage(apiPage('p3', { date: null })), null);
  assert.equal(tradeFromPage({ id: 'p4' }), null);
});

test('queryTrades follows pagination and sends the filter', async () => {
  const notion = fakeNotion();
  notion.state.pageSize = 2;
  notion.state.dashboardPages = [apiPage('a'), apiPage('b'), apiPage('c', { date: null }), apiPage('d'), apiPage('e')];
  const { sync } = syncWith({ notion });
  const rows = await sync.queryTrades({ from: '2026-10-01T00:00:00.000Z', to: null });
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'd', 'e']);
  const queries = notion.calls.filter((c) => c.endpoint === 'data_sources/ds1/query');
  assert.equal(queries.length, 3);
  assert.deepEqual(queries.map((q) => q.body.start_cursor), [undefined, '2', '4']);
  assert.deepEqual(queries[0].body.sorts, [{ property: 'Date', direction: 'ascending' }]);
  assert.equal(queries[0].body.filter.and.length, 3);
});

test('queryTrades never touches the sync queue and fails loudly without credentials', async () => {
  const { sync, fs } = syncWith();
  await sync.queryTrades();
  assert.equal(fs.files.size, 0);
  await assert.rejects(syncWith({ env: { token: null, databaseId: null } }).sync.queryTrades(), /NOTION_TOKEN/);
});

test('onWrite fires once a close lands in Notion, not at entry', async () => {
  const written = [];
  const { sync, drain } = syncWith({ onWrite: (id) => written.push(id) });
  sync.tradeOpened(OPENED);
  await drain();
  assert.deepEqual(written, []);
  sync.tradeClosed(ROW);
  await drain();
  assert.deepEqual(written, ['0xabc']);
});
