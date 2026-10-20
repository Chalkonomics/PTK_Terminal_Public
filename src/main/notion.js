import nodeFs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Mirrors each trade into the user's Notion "Trades" database: a page at entry
// (with the database's default template, so the note sections are there), then
// the result columns at close. The user fills Setup, Entry, Confluence and Demon
// by hand; this module never touches those columns or the page body.
//
// Notion must never get in the way of trading. Every write is queued in
// notion-pending.json and sent in order from tick(), retried with backoff when
// Notion is down or slow. The CSV stays the source of truth.
//
// Each job is an upsert keyed on the tradeId column, so a retry after a timeout
// (when the first attempt may have landed) never creates a second page.

/** Column names in the Notion database. */
export const PROPS = Object.freeze({
  title: 'Name',
  tradeId: 'tradeId',
  direction: 'Direction',
  date: 'Date',
  asset: 'Asset',
  outcome: 'Trade Outcome',
  pnlGross: 'PnL Gross',
  pnlNet: 'PnL Net',
  rGross: 'R Gross',
  rNet: 'R Net',
  missed: 'Missed', // filled by the trader; read by the trades dashboard
});

const API = 'https://api.notion.com/v1/';
const NOTION_VERSION = '2025-09-03';
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const BE_BAND_R = 0.1; // |net R| below this is a scratch, not a win or loss

/** Whether trades in `mode` go to Notion. Mainnet only, unless notionTestnet is on for testing. */
export function syncsMode(config, mode) {
  return config.notionSync && (mode === 'live' || (mode === 'testnet' && config.notionTestnet));
}

/** Win / Loss / BE from net R. */
export function outcomeFor(rNet) {
  if (Math.abs(rNet) < BE_BAND_R) return 'BE';
  return rNet > 0 ? 'Win' : 'Loss';
}

/** e.g. "BTC Long · 5 Oct 11:19", in local time. */
export function tradeTitle({ coin, direction, tsEntry }, timeZone) {
  const when = new Date(tsEntry).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone });
  return `${coin} ${direction === 'long' ? 'Long' : 'Short'} · ${when.replace(',', '')}`;
}

/** Notion filter for the dashboard: taken (Missed unticked), closed (not Open), Date in [from, to). */
export function tradesFilter({ from, to }) {
  return [
    { property: PROPS.missed, checkbox: { equals: false } },
    { property: PROPS.outcome, select: { does_not_equal: 'Open' } },
    ...(from ? [{ property: PROPS.date, date: { on_or_after: from } }] : []),
    ...(to ? [{ property: PROPS.date, date: { before: to } }] : []),
  ];
}

/** A Notion page as a plain dashboard row, or null if it has no date. Empty numbers stay null. */
export function tradeFromPage(page) {
  const p = page.properties ?? {};
  const date = p[PROPS.date]?.date?.start;
  if (!date) return null;
  const num = (key) => (Number.isFinite(p[PROPS[key]]?.number) ? p[PROPS[key]].number : null);
  return {
    id: page.id,
    url: page.url ?? null,
    title: (p[PROPS.title]?.title ?? []).map((t) => t.plain_text ?? '').join(''),
    date,
    direction: p[PROPS.direction]?.select?.name ?? null,
    outcome: p[PROPS.outcome]?.select?.name ?? null,
    rGross: num('rGross'),
    rNet: num('rNet'),
    pnlGross: num('pnlGross'),
    pnlNet: num('pnlNet'),
  };
}

const text = (s) => [{ type: 'text', text: { content: String(s) } }];
const r2 = (n) => Math.round(n * 100) / 100;

/** Columns written when the trade opens. Works from the open-trade record or a closed CSV row. */
export function entryProperties({ tradeId, coin, direction, tsEntry }, timeZone) {
  return {
    [PROPS.title]: { title: text(tradeTitle({ coin, direction, tsEntry }, timeZone)) },
    [PROPS.tradeId]: { rich_text: text(tradeId) },
    [PROPS.direction]: { select: { name: direction.toUpperCase() } },
    [PROPS.date]: { date: { start: new Date(tsEntry).toISOString() } },
    [PROPS.asset]: { rich_text: text(coin) },
    [PROPS.outcome]: { select: { name: 'Open' } },
  };
}

/** Columns written when the trade closes, from the journal row (P&L net of fees, R on planned risk). */
export function closeProperties(row) {
  const gross = row.pnlUsd + row.feesUsd;
  const rGross = row.plannedRiskUsd > 0 ? gross / row.plannedRiskUsd : null;
  return {
    [PROPS.outcome]: { select: { name: outcomeFor(row.pnlR ?? row.pnlUsd) } },
    [PROPS.pnlGross]: { number: r2(gross) },
    [PROPS.pnlNet]: { number: r2(row.pnlUsd) },
    [PROPS.rGross]: { number: rGross === null ? null : r2(rGross) },
    [PROPS.rNet]: { number: row.pnlR === null ? null : r2(row.pnlR) },
  };
}

/** NOTION_TOKEN and NOTION_DATABASE_ID from .env, without touching process.env. */
export function loadNotionEnv(rootDir, fs = nodeFs) {
  try {
    const env = dotenv.parse(fs.readFileSync(path.join(rootDir, '.env'), 'utf8'));
    return { token: env.NOTION_TOKEN?.trim() || null, databaseId: env.NOTION_DATABASE_ID?.trim() || null };
  } catch {
    return { token: null, databaseId: null };
  }
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.rootDir                      where notion-pending.json lives
 * @param {{ token: string | null, databaseId: string | null }} deps.env
 * @param {typeof fetch} [deps.fetch]
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {typeof nodeFs} [deps.fs]
 * @param {string} [deps.timeZone]                   for page titles; the PC's zone by default
 * @param {(tradeId: string) => void} [deps.onWrite]  after a close or discard has landed in Notion
 */
export function createNotionSync({ config, rootDir, env, fetch = globalThis.fetch, log = console.log, now = Date.now, fs = nodeFs, timeZone, onWrite = () => {} }) {
  const queuePath = path.join(rootDir, 'notion-pending.json');
  const configError = !env.token || !env.databaseId ? 'NOTION_TOKEN or NOTION_DATABASE_ID missing from .env' : null;

  let queue = readQueue();
  let dataSourceId = null;
  let sending = false;
  let lastError = configError;
  if (config.notionSync && configError) log(`[notion] ${configError}; trades will queue until it is fixed and the app restarted`);
  if (queue.length) log(`[notion] ${queue.length} update(s) waiting from a previous session`);

  function readQueue() {
    try {
      return fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
    } catch {
      return [];
    }
  }

  function saveQueue() {
    try {
      if (queue.length) fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
      else if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    } catch (err) {
      log(`[notion] could not save the queue: ${err.message}`);
    }
  }

  /** A job carries the entry columns too, so a close can create the page if the entry never landed. */
  function enqueue(job) {
    const waiting = queue.find((j) => j.tradeId === job.tradeId && !j.attempts);
    if (waiting) Object.assign(waiting, job);
    else queue.push({ ...job, attempts: 0, nextAt: 0 });
    saveQueue();
  }

  async function request(method, endpoint, body) {
    const res = await fetch(API + endpoint, {
      method,
      headers: { Authorization: `Bearer ${env.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw Object.assign(new Error(`Notion ${res.status} ${json.code ?? ''}: ${json.message ?? res.statusText}`), {
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      });
    }
    return json;
  }

  async function resolveDataSource() {
    if (!dataSourceId) dataSourceId = (await request('GET', `databases/${env.databaseId}`)).data_sources[0].id;
    return dataSourceId;
  }

  async function findPage(tradeId) {
    const q = await request('POST', `data_sources/${dataSourceId}/query`, { filter: { property: PROPS.tradeId, rich_text: { equals: tradeId } }, page_size: 1 });
    return q.results[0]?.id ?? null;
  }

  async function send(job) {
    await resolveDataSource();
    const pageId = await findPage(job.tradeId);
    if (job.discard) {
      if (pageId) await request('PATCH', `pages/${pageId}`, { in_trash: true });
      return pageId ? 'removed' : 'nothing to remove';
    }
    if (pageId && !job.close) return 'already exists';
    if (pageId) {
      await request('PATCH', `pages/${pageId}`, { properties: job.close });
      return 'updated';
    }
    await request('POST', 'pages', {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      template: { type: 'default', ...(timeZone ? { timezone: timeZone } : {}) },
      properties: { ...job.entry, ...job.close },
    });
    return 'created';
  }

  async function sendHead() {
    sending = true;
    const job = queue[0];
    try {
      const result = await send(job);
      log(`[notion] ${job.tradeId}: ${result}`);
      queue.shift();
      lastError = null;
      if (job.close || job.discard) notifyWrite(job.tradeId);
    } catch (err) {
      job.attempts += 1;
      job.nextAt = now() + (err.retryAfterMs ?? RETRY_MS[Math.min(job.attempts, RETRY_MS.length) - 1]);
      lastError = err.name === 'TimeoutError' ? 'Notion did not respond' : err.message;
      log(`[notion] ${job.tradeId}: attempt ${job.attempts} failed (${lastError})`);
    } finally {
      saveQueue();
      sending = false;
    }
  }

  function notifyWrite(tradeId) {
    try {
      onWrite(tradeId);
    } catch (err) {
      log(`[notion] onWrite failed: ${err.message}`);
    }
  }

  return {
    /**
     * Closed, taken trades with Date in [from, to), oldest first, for the trades dashboard.
     * A read only: it never touches the sync queue. Throws if Notion can't be reached.
     * @param {{ from?: string | null, to?: string | null }} [range]  ISO instants; null = unbounded
     */
    async queryTrades({ from = null, to = null } = {}) {
      if (configError) throw new Error(configError);
      await resolveDataSource();
      const body = { filter: { and: tradesFilter({ from, to }) }, sorts: [{ property: PROPS.date, direction: 'ascending' }], page_size: 100 };
      const rows = [];
      for (let cursor = null; ;) {
        const page = await request('POST', `data_sources/${dataSourceId}/query`, cursor ? { ...body, start_cursor: cursor } : body);
        rows.push(...page.results.map(tradeFromPage).filter(Boolean));
        if (!page.has_more || !page.next_cursor) return rows;
        cursor = page.next_cursor;
      }
    },
    tradeOpened(record) {
      if (!syncsMode(config, record.mode)) return;
      enqueue({ tradeId: record.tradeId, entry: entryProperties(record, timeZone), close: null, discard: false });
    },
    tradeClosed(row) {
      if (!syncsMode(config, row.mode)) return;
      enqueue({ tradeId: row.tradeId, entry: entryProperties({ ...row, coin: config.symbol }, timeZone), close: closeProperties(row), discard: false });
    },
    /** The journal found no fills: no trade took place, so the page made at entry goes to the bin. */
    tradeDiscarded(record) {
      if (!syncsMode(config, record.mode)) return;
      enqueue({ tradeId: record.tradeId, entry: null, close: null, discard: true });
    },
    /** Called every second: sends the oldest queued update when it is due. One at a time, in order. */
    tick() {
      if (configError || sending || !queue.length || now() < queue[0].nextAt) return;
      sendHead();
    },
    status() {
      if (!config.notionSync && !queue.length) return null;
      return { pending: queue.length, error: lastError };
    },
    /** Test hook: whether a send is in flight. */
    get sending() {
      return sending;
    },
  };
}
