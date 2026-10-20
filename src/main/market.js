import { HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport } from '@nktkas/hyperliquid';
import { parseMarketSpec } from './marketSpec.js';
import { deriveAccount } from './account.js';

// Market and account data. Dry run and live read mainnet (dry run shadows real
// manual trading); testnet reads testnet. This module never signs or sends orders.
//
// Unified accounts hold perp collateral in the spot balance, and Hyperliquid documents
// the spot clearinghouse state as the source of truth for them; the perp account value
// reads 0. Portfolio margin pools non-USDC assets, so "equity" is ambiguous and it is refused.

const RETRY_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

export function createMarket({ config, log = console.log, now = Date.now }) {
  const isTestnet = config.mode === 'testnet';
  const user = config.accountAddress || null;
  const coin = config.symbol;
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet, timeout: REQUEST_TIMEOUT_MS }) });

  let ws = null;
  let retryTimer = null;
  let stopped = false;

  const s = {
    status: 'starting', // starting | ready | error
    error: null,
    wsOpen: false,
    spec: null,
    mark: null,
    markAt: null,
    abstraction: null,
    takerFeeRate: null,
    clearinghouse: null,
    spot: null,
    orders: null,
    assetData: null,
    accountAt: null,
  };

  async function connect() {
    clearTimeout(retryTimer);
    try {
      s.status = 'starting';
      s.spec = parseMarketSpec(await info.meta(), coin);
      if (user) {
        s.abstraction = await info.userAbstraction({ user });
        if (s.abstraction === 'portfolioMargin') throw new Error('portfolio margin accounts are not supported (equity is ambiguous)');
        const fees = await info.userFees({ user });
        s.takerFeeRate = Number(fees.userCrossRate);
      }

      ws = new WebSocketTransport({ isTestnet });
      ws.socket.addEventListener('open', () => (s.wsOpen = true));
      ws.socket.addEventListener('close', () => (s.wsOpen = false));
      const subs = new SubscriptionClient({ transport: ws });
      const options = { onError: (err) => fail(`subscription lost: ${err.message}`) };

      await subs.activeAssetCtx({ coin }, (e) => {
        s.mark = Number(e.ctx.markPx);
        s.markAt = now();
      }, options);

      if (user) {
        await Promise.all([
          subs.clearinghouseState({ user }, (e) => setAccount({ clearinghouse: e.clearinghouseState }), options),
          subs.openOrders({ user }, (e) => setAccount({ orders: e.orders }), options),
          subs.activeAssetData({ user, coin }, (e) => setAccount({ assetData: e }), options),
          subs.spotState({ user }, (e) => setAccount({ spot: e.spotState }), options),
        ]);
        await refreshAccount();
      }

      s.wsOpen = true;
      s.status = 'ready';
      s.error = null;
      log(`[market] ready on ${isTestnet ? 'testnet' : 'mainnet'}: ${coin} asset ${s.spec.assetId}, szDecimals ${s.spec.szDecimals}, maxLeverage ${s.spec.maxLeverage}`);
    } catch (err) {
      fail(err.message);
    }
  }

  function fail(message) {
    if (stopped) return;
    s.status = 'error';
    s.error = message;
    log(`[market] error: ${message}; reconnecting in ${RETRY_MS / 1000}s`);
    closeSocket();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RETRY_MS);
  }

  function closeSocket() {
    try {
      ws?.close();
    } catch {
      // already closed
    }
    ws = null;
    s.wsOpen = false;
  }

  function setAccount(patch) {
    Object.assign(s, patch);
    s.accountAt = now();
  }

  /**
   * Fetches position, orders and asset data directly from REST, bypassing the
   * WebSocket. Used at press time so the gate runs on the exchange's current state.
   */
  async function refreshAccount() {
    if (!user) return null;
    const [clearinghouse, orders, assetData, spot] = await Promise.all([
      info.clearinghouseState({ user }),
      info.frontendOpenOrders({ user }),
      info.activeAssetData({ user, coin }),
      info.spotClearinghouseState({ user }),
    ]);
    setAccount({ clearinghouse, orders, assetData, spot });
    return deriveAccount(s);
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      closeSocket();
    },
    refreshAccount,
    /** All of the account's fills since startTime (ms), oldest first. */
    async fetchFills(startTime) {
      if (!user) return [];
      return info.userFillsByTime({ user, startTime, aggregateByTime: false });
    },
    snapshot() {
      return {
        network: isTestnet ? 'testnet' : 'mainnet',
        status: s.status,
        error: s.error,
        wsOpen: s.wsOpen,
        spec: s.spec,
        mark: s.mark,
        takerFeeRate: s.takerFeeRate,
        markAgeMs: s.markAt === null ? null : now() - s.markAt,
        account: deriveAccount(s),
        accountAgeMs: s.accountAt === null ? null : now() - s.accountAt,
      };
    },
  };
}
