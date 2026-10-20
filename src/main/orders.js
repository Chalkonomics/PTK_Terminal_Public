import { randomUUID } from 'node:crypto';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { loadAgentKey } from './config.js';

// Order submission. The entry and its reduce-only stop go out together in one
// signed action, so the stop lives on the exchange rather than in this process.
// The exchange's response is never trusted on its own: after every submission
// the position and orders are read back and the outcome decided from that.

const EXCHANGE_TIMEOUT_MS = 4000;

// Testnet-only fault injection, so the failure paths can be exercised against the
// real exchange as the spec requires. Ignored outside testnet.
//   bad-stop         stop trigger has invalid precision (exchange rejects the whole action)
//   stop-wrong-side  stop trigger 5% on the wrong side of the market
//   no-stop          entry sent without its stop, and the stop retry has an invalid price
const FAULTS = new Set(['bad-stop', 'stop-wrong-side', 'no-stop']);

function withFault(fault, order) {
  if (!fault || !order.t.trigger) return order;
  const px = order.t.trigger.triggerPx;
  let triggerPx = px;
  if (fault === 'bad-stop' || fault === 'no-stop') triggerPx = `${px}.123`;
  // A long's stop is a sell (b=false): push it above the market, and vice versa.
  if (fault === 'stop-wrong-side') triggerPx = String(Math.round(Number(px) * (order.b ? 0.95 : 1.05)));
  return { ...order, t: { trigger: { ...order.t.trigger, triggerPx } } };
}

/** A fresh 16-byte client order ID. */
export function newCloid() {
  return `0x${randomUUID().replace(/-/g, '')}`;
}

/**
 * The order action for a plan: IOC limit entry + reduce-only stop-market trigger,
 * grouped normalTpsl so the stop activates only once the entry fills.
 */
export function buildOrderAction(plan, spec, { entryCloid, stopCloid }) {
  const isBuy = plan.direction === 'long';
  return {
    orders: [
      {
        a: spec.assetId,
        b: isBuy,
        p: plan.entryLimitPxStr,
        s: plan.sizeStr,
        r: false,
        t: { limit: { tif: 'Ioc' } },
        c: entryCloid,
      },
      {
        a: spec.assetId,
        b: !isBuy,
        p: plan.stopLimitPxStr,
        s: plan.sizeStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: plan.stopPxStr, tpsl: 'sl' } },
        c: stopCloid,
      },
    ],
    grouping: 'normalTpsl',
  };
}

/**
 * Interprets what the exchange said. The SDK throws if any order in a batch
 * errors, but keeps the full response on the error, so a filled entry with a
 * rejected stop is still visible here. Transport failures (timeouts, network)
 * carry no response and are ambiguous: the order may or may not have executed.
 */
export function classifySubmission({ response, error }) {
  if (error) {
    const r = error.name === 'ApiRequestError' ? error.response : undefined;
    if (!r) return { kind: 'ambiguous', reason: error.message };
    // A top-level error means the action was refused outright; nothing executed.
    if (r.status === 'err') return { kind: 'rejected', reason: String(r.response) };
    response = r;
  }

  const statuses = response?.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return { kind: 'ambiguous', reason: 'unrecognised exchange response' };

  const [e, s] = statuses;
  let entry;
  if (e?.filled) entry = { filled: true, totalSz: Number(e.filled.totalSz), avgPx: Number(e.filled.avgPx), oid: e.filled.oid };
  else if (e?.error) entry = { filled: false, error: e.error };
  else if (e?.resting) entry = { filled: false, resting: true, oid: e.resting.oid };
  else entry = { filled: false, error: `unexpected entry status ${JSON.stringify(e)}` };

  let stop;
  if (s === undefined) stop = { accepted: false, error: 'no stop status returned' };
  else if (typeof s === 'string') stop = { accepted: true, status: s };
  else if (s.error) stop = { accepted: false, error: s.error };
  else if (s.resting) stop = { accepted: true, oid: s.resting.oid };
  else stop = { accepted: false, error: `unexpected stop status ${JSON.stringify(s)}` };

  return { kind: 'responded', entry, stop };
}

/**
 * Decides the outcome from the account as read back from the exchange after the
 * submission. The exchange's state is the truth; the response is supporting detail.
 *
 * @returns {{ kind: 'protected' | 'unprotected' | 'notFilled' | 'unknown', reason?: string, position?: object, leftoverOrders?: number }}
 */
export function assessOutcome(submission, account, plan) {
  if (!account) return { kind: 'unknown', reason: 'could not read the account after submitting' };

  const position = account.position;
  if (position) {
    const direction = position.size > 0 ? 'long' : 'short';
    if (direction !== plan.direction) {
      return { kind: 'unknown', reason: `a ${direction} position is open but a ${plan.direction} was sent`, position };
    }
    if (position.stop?.coversSize) return { kind: 'protected', position };
    const why = position.stop ? 'stop covers only part of the position' : 'no stop on the exchange';
    const detail = submission.stop?.error ? ` (stop error: ${submission.stop.error})` : '';
    return { kind: 'unprotected', reason: why + detail, position };
  }

  if (submission.kind === 'responded' && submission.entry.filled) {
    // Fill reported but no position visible: lag, or already stopped out. The caller re-checks.
    return { kind: 'unknown', reason: 'exchange reported a fill but no position is visible', fill: submission.entry };
  }
  const reason = submission.kind === 'responded' ? submission.entry.error : submission.reason;
  return { kind: 'notFilled', reason, leftoverOrders: account.orders.length };
}

/**
 * Creates the order executor for testnet or live. Loads the agent key (never
 * logged or exposed) and verifies the agent is approved for the account.
 */
export function createExecutor({ config, rootDir, log = console.log }) {
  const isTestnet = config.mode === 'testnet';
  const user = config.accountAddress;
  const status = { ready: false, error: 'not initialised', agentAddress: null, agentValidUntil: null, fault: null };
  let exchange = null;
  const fault = isTestnet && FAULTS.has(process.env.PTK_FAULT) ? process.env.PTK_FAULT : null;
  if (fault) {
    status.fault = fault;
    log(`[orders] !!! FAULT INJECTION ACTIVE (testnet): ${fault}`);
  }

  async function init() {
    try {
      const wallet = privateKeyToAccount(await loadAgentKey(rootDir, config.mode));
      status.agentAddress = wallet.address;
      const transport = new HttpTransport({ isTestnet, timeout: EXCHANGE_TIMEOUT_MS });
      const agents = await new InfoClient({ transport }).extraAgents({ user });
      const approved = agents.find((a) => a.address.toLowerCase() === wallet.address.toLowerCase());
      if (!approved) {
        throw new Error(`API wallet ${wallet.address} is not approved for ${user} on ${isTestnet ? 'testnet' : 'mainnet'}; authorise it in the Hyperliquid UI (API page)`);
      }
      // validUntil is null for agents with no expiry.
      if (approved.validUntil !== null && approved.validUntil <= Date.now()) {
        throw new Error(`API wallet ${wallet.address} expired ${new Date(approved.validUntil).toISOString()}`);
      }
      status.agentValidUntil = approved.validUntil;
      exchange = new ExchangeClient({ transport, wallet });
      status.ready = true;
      status.error = null;
      const expiry = approved.validUntil === null ? 'no expiry' : `valid until ${new Date(approved.validUntil).toISOString()}`;
      log(`[orders] ready on ${isTestnet ? 'testnet' : 'mainnet'}: agent ${wallet.address}, ${expiry}`);
    } catch (err) {
      status.ready = false;
      status.error = err.message;
      log(`[orders] not ready: ${err.message}`);
    }
  }

  /**
   * Sends the entry + stop action. Never throws; returns the classified result
   * with the raw exchange response (or error message) attached for the log.
   */
  async function submit(action) {
    if (!exchange) return { kind: 'rejected', reason: status.error ?? 'executor not ready' };
    let sent = action;
    if (fault === 'no-stop') sent = { orders: [action.orders[0]], grouping: 'na' };
    else if (fault) sent = { ...action, orders: action.orders.map((o) => withFault(fault, o)) };
    if (sent !== action) log(`[orders] !!! FAULT ${fault}: actually sending ${JSON.stringify(sent)}`);
    try {
      const response = await exchange.order(sent);
      return { ...classifySubmission({ response }), raw: response };
    } catch (error) {
      return { ...classifySubmission({ error }), raw: error.response ?? { error: error.message } };
    }
  }

  /** Runs one exchange call; never throws. Per-order errors come back as `error`. */
  async function call(fn) {
    if (!exchange) return { ok: false, error: status.error ?? 'executor not ready' };
    try {
      const response = await fn();
      return { ok: true, response, statuses: response.response?.data?.statuses };
    } catch (error) {
      const statuses = error.response?.response?.data?.statuses;
      return { ok: false, error: error.message, statuses };
    }
  }

  /** A standalone reduce-only stop-market trigger for an open position. */
  function placeStop({ assetId, isLong, sizeStr, triggerPxStr, limitPxStr }) {
    const order = withFault(fault, {
      a: assetId,
      b: !isLong,
      p: limitPxStr,
      s: sizeStr,
      r: true,
      t: { trigger: { isMarket: true, triggerPx: triggerPxStr, tpsl: 'sl' } },
      c: newCloid(),
    });
    return call(() => exchange.order({ orders: [order], grouping: 'na' }));
  }

  /** Reduce-only IOC close. Reduce-only can never open or flip a position. */
  function closePosition({ assetId, isLong, sizeStr, limitPxStr }) {
    return call(() =>
      exchange.order({
        orders: [{ a: assetId, b: !isLong, p: limitPxStr, s: sizeStr, r: true, t: { limit: { tif: 'Ioc' } }, c: newCloid() }],
        grouping: 'na',
      }),
    );
  }

  function cancel({ assetId, oids }) {
    if (!oids.length) return Promise.resolve({ ok: true, statuses: [] });
    return call(() => exchange.cancel({ cancels: oids.map((o) => ({ a: assetId, o })) }));
  }

  return { init, submit, placeStop, closePosition, cancel, status };
}
