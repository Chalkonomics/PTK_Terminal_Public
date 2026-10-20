import { LIVE_DISARMED, validate } from './gate.js';
import { switchBlockers } from './session.js';

// Central application state and the panel snapshot. The ready light comes from
// the same validate() the hotkeys call, with direction inferred from stop vs mark.

export function createStore({ config, watcher, market, execution = null, journal = null, notion = null, prefs = { alwaysOnTop: true, compact: false }, liveArmed = false, now = Date.now }) {
  const ui = {
    setupLabel: config.setupLabels[0],
    lastAction: null, // { at, kind: 'accepted' | 'refused' | 'error' | 'info', text }
    hotkeys: [],      // [{ action, accelerator, registered }]
    busy: false,      // press lock held
    liveArmed,        // live trading confirmed this session (always false at a normal startup)
    prefs: { ...prefs },
  };

  return {
    get setupLabel() {
      return ui.setupLabel;
    },
    setSetupLabel(label) {
      if (config.setupLabels.includes(label)) ui.setupLabel = label;
    },
    setLastAction(kind, text) {
      ui.lastAction = { at: now(), kind, text };
    },
    setHotkeys(hotkeys) {
      ui.hotkeys = hotkeys;
    },
    setBusy(busy) {
      ui.busy = busy;
    },
    armLive() {
      ui.liveArmed = true;
    },
    get prefs() {
      return { ...ui.prefs };
    },
    setPrefs(patch) {
      Object.assign(ui.prefs, patch);
    },
    /** Reasons a mode switch must wait (empty when allowed). Re-checked by main before switching. */
    switchBlockers() {
      return switchBlockers({ account: market.snapshot().account, accountless: config.mode === 'dryRun' && !config.accountAddress, journal: journal?.status() ?? null, busy: ui.busy });
    },
    clipboardSnapshot() {
      return watcher.snapshot();
    },
    gate(direction = null) {
      return validate({ config, market: market.snapshot(), clipboard: watcher.snapshot(), direction, execution, liveArmed: ui.liveArmed });
    },
    snapshot() {
      const mkt = market.snapshot();
      const clip = watcher.snapshot();
      const gate = validate({ config, market: mkt, clipboard: clip, direction: null, execution, liveArmed: ui.liveArmed });
      const journalStatus = journal?.status() ?? null;
      const blockers = switchBlockers({ account: mkt.account, accountless: config.mode === 'dryRun' && !config.accountAddress, journal: journalStatus, busy: ui.busy });
      return buildPanelState({ config, market: mkt, clipboard: clip, gate, ui, execution, journal: journalStatus, notion: notion?.status() ?? null, switchBlockers: blockers, now: now() });
    },
  };
}

/**
 * Shapes everything the panel displays into a plain, IPC-serialisable object.
 * No secrets, no Infinity, nothing the renderer has to compute.
 */
export function buildPanelState({ config, market, clipboard, gate, ui, execution = null, journal = null, notion = null, switchBlockers = [], now }) {
  const account = market.account;
  const finite = (n) => (Number.isFinite(n) ? n : null);

  return {
    mode: config.mode,
    symbol: config.symbol,
    feed: {
      ok: market.status === 'ready' && market.wsOpen,
      status: market.status,
      network: market.network,
      error: market.error,
      mark: market.mark,
      markStale: market.markAgeMs === null || market.markAgeMs > config.markMaxAgeMs,
    },
    clipboard: {
      raw: clipboard.raw === null ? null : clipboard.raw.slice(0, 40),
      value: clipboard.value,
      error: clipboard.error,
      ageMs: finite(clipboard.ageMs),
      ageLevel: !Number.isFinite(clipboard.ageMs) || clipboard.ageMs > config.clipboardMaxAgeMs
        ? 'bad'
        : clipboard.ageMs > config.clipboardWarnAgeMs ? 'warn' : 'ok',
    },
    ready: {
      level: gate.level,
      direction: gate.direction,
      failed: gate.failed,
      warnings: gate.warnings,
      checks: gate.checks,
    },
    plan: gate.plan && {
      direction: gate.plan.direction,
      stopPx: gate.plan.stopPx,
      stopDistance: gate.plan.stopDistance,
      stopDistancePct: gate.plan.stopDistancePct,
      size: gate.plan.size,
      sizeStr: gate.plan.sizeStr,
      notional: gate.plan.notional,
      margin: gate.plan.margin,
      marginUsage: gate.marginUsage,
      riskUsd: gate.plan.riskUsd,
      riskPct: gate.plan.riskPct,
      riskBudget: gate.plan.riskBudget,
      feesUsd: gate.plan.feesUsd,
      feesR: gate.plan.feesR,
      takerFeeRate: gate.plan.takerFeeRate,
      feeRateAssumed: market.takerFeeRate == null,
      liqPx: gate.plan.liqPx,
      entryLimitPx: gate.plan.entryLimitPx,
    },
    account: account && {
      equity: config.equitySource === 'fixed' ? config.equityFixed : account.equity,
      equityLabel: config.equitySource === 'fixed' ? 'fixed (config)' : account.equityBasis,
      liveEquity: account.equity,
      leverage: account.leverage,
      leverageOk: account.leverage.type === 'isolated' && account.leverage.value === config.leverage,
      freeCollateral: account.availableToTrade.buy,
      openOrders: account.orders.length,
      position: account.position && {
        size: account.position.size,
        entryPx: account.position.entryPx,
        unrealizedPnl: account.position.unrealizedPnl,
        liquidationPx: account.position.liquidationPx,
        stop: account.position.stop,
      },
    },
    accountless: config.mode === 'dryRun' && !config.accountAddress,
    expectedLeverage: config.leverage,
    riskPctTarget: config.riskPct,
    setupLabels: config.setupLabels,
    setupLabel: ui.setupLabel,
    lastAction: ui.lastAction && { ...ui.lastAction, ageMs: now - ui.lastAction.at },
    hotkeys: ui.hotkeys.length
      ? ui.hotkeys
      : [
          { action: 'long', accelerator: config.hotkeyLong, registered: null },
          { action: 'short', accelerator: config.hotkeyShort, registered: null },
          { action: 'panic', accelerator: config.hotkeyPanic, registered: null },
        ],
    busy: ui.busy,
    journal,
    notion,
    menu: {
      switchBlockers,
      alwaysOnTop: ui.prefs?.alwaysOnTop ?? true,
      compact: ui.prefs?.compact ?? false,
    },
    // Show the Arm LIVE button only when arming is the one thing stopping trading.
    needsArm: config.mode === 'live' && !ui.liveArmed && gate.failed?.detail === LIVE_DISARMED,
    execution: execution && {
      ready: execution.ready,
      error: execution.error,
      agentAddress: execution.agentAddress,
      agentValidUntil: execution.agentValidUntil,
    },
  };
}
