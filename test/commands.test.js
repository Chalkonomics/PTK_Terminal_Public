import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from '../src/main/commands.js';
import { createStore } from '../src/main/store.js';
import { DEFAULTS } from '../src/main/config.js';
import { SPEC } from './fixtures.js';

const ADDRESS = '0x' + 'a'.repeat(40);

function setup({ mode = 'testnet', account = {}, journalOpen = null, saveThrows = null, openError = null, prefs } = {}) {
  const effects = { saved: [], prefs: [], relaunched: null, opened: [], windows: [], onTop: [], resized: [], quit: false };
  const config = { ...DEFAULTS, mode, accountAddress: ADDRESS, equitySource: 'fixed', equityFixed: 1000, setupLabels: ['Break', 'Sweep'] };
  const market = {
    snapshot: () => ({
      network: 'testnet', status: 'ready', error: null, wsOpen: true, spec: SPEC, mark: 83_520, markAgeMs: 300,
      account: { equity: 900, equityBasis: 'x', position: null, orders: [], leverage: { type: 'isolated', value: 20 }, availableToTrade: { buy: 900, sell: 900 }, ...account },
    }),
  };
  const watcher = { snapshot: () => ({ raw: null, value: null, error: 'x', capturedAt: null, ageMs: Infinity }) };
  const journal = { status: () => ({ open: journalOpen, pending: 0, error: null }) };
  const store = createStore({ config, watcher, market, journal, prefs, execution: { ready: true, error: null } });
  const commands = createCommands({
    config,
    store,
    saveConfigPatch: (patch) => {
      if (saveThrows) throw new Error(saveThrows);
      effects.saved.push(patch);
    },
    saveUiPrefs: (p) => effects.prefs.push(p),
    relaunch: (opts) => (effects.relaunched = opts),
    open: (target) => {
      effects.opened.push(target);
      return openError;
    },
    openWindow: (name) => effects.windows.push(name),
    setAlwaysOnTop: (on) => effects.onTop.push(on),
    resize: (h) => effects.resized.push(h),
    quit: () => (effects.quit = true),
    log: () => {},
  });
  return { commands, store, effects };
}

test('unknown commands are rejected; nothing can place an order', () => {
  const { commands } = setup();
  assert.deepEqual(commands.handle('placeOrder', {}), { ok: false, error: 'unknown command placeOrder' });
  assert.deepEqual(commands.handle('__proto__', {}), { ok: false, error: 'unknown command __proto__' });
  assert.ok(!commands.names.some((n) => /order|submit|long|short|panic/i.test(n)));
});

test('switching down to dry run saves and relaunches unarmed', () => {
  const { commands, effects } = setup();
  assert.deepEqual(commands.handle('setMode', { mode: 'dryRun' }), { ok: true, relaunching: true });
  assert.deepEqual(effects.saved, [{ mode: 'dryRun' }]);
  assert.deepEqual(effects.relaunched, { armLive: false });
});

test('switching to live needs confirmation, then relaunches armed', () => {
  const { commands, effects } = setup();
  assert.deepEqual(commands.handle('setMode', { mode: 'live' }), { ok: false, error: 'confirmation required', needsConfirm: true });
  assert.equal(effects.relaunched, null);
  assert.deepEqual(effects.saved, []);
  assert.deepEqual(commands.handle('setMode', { mode: 'live', confirmed: true }), { ok: true, relaunching: true });
  assert.deepEqual(effects.relaunched, { armLive: true });
});

test('switching is refused while a position is open, even if the menu allowed the click', () => {
  const { commands, store, effects } = setup({ account: { position: { size: 0.03 } } });
  const r = commands.handle('setMode', { mode: 'dryRun' });
  assert.equal(r.ok, false);
  assert.match(r.error, /a BTC position is open/);
  assert.match(store.snapshot().lastAction.text, /Mode switch blocked/);
  assert.equal(effects.relaunched, null);
});

test('switching is refused while the journal tracks a trade or a press runs', () => {
  assert.match(setup({ journalOpen: { tradeId: '0x1' } }).commands.handle('setMode', { mode: 'dryRun' }).error, /journal/);
  const busy = setup();
  busy.store.setBusy(true);
  assert.match(busy.commands.handle('setMode', { mode: 'dryRun' }).error, /press or panic/);
});

test('same mode is a no-op; invalid modes and failed saves are reported', () => {
  const same = setup();
  assert.deepEqual(same.commands.handle('setMode', { mode: 'testnet' }), { ok: true });
  assert.equal(same.effects.relaunched, null);
  assert.match(setup().commands.handle('setMode', { mode: 'yolo' }).error, /unknown mode/);
  const bad = setup({ saveThrows: 'refusing to save config.json: accountAddress …' });
  assert.equal(bad.commands.handle('setMode', { mode: 'dryRun' }).ok, false);
  assert.equal(bad.effects.relaunched, null);
  assert.match(bad.store.snapshot().lastAction.text, /Mode switch failed/);
});

test('arming LIVE only works in live mode', () => {
  assert.match(setup({ mode: 'testnet' }).commands.handle('armLive').error, /not in live mode/);
  const live = setup({ mode: 'live' });
  assert.equal(live.store.snapshot().needsArm, true);
  assert.deepEqual(live.commands.handle('armLive'), { ok: true });
  assert.equal(live.store.snapshot().needsArm, false);
});

test('preferences toggle, apply and persist', () => {
  const { commands, store, effects } = setup({ prefs: { alwaysOnTop: true, compact: false } });
  assert.deepEqual(commands.handle('toggleAlwaysOnTop'), { ok: true, alwaysOnTop: false });
  assert.deepEqual(effects.onTop, [false]);
  assert.deepEqual(commands.handle('toggleCompact'), { ok: true, compact: true });
  assert.deepEqual(effects.prefs.at(-1), { alwaysOnTop: false, compact: true });
  assert.deepEqual(store.snapshot().menu, { switchBlockers: [], alwaysOnTop: false, compact: true });
});

test('open journal / logs report problems on the panel', () => {
  const missing = setup({ openError: 'No trades yet: trades.csv is created on the first press' });
  assert.equal(missing.commands.handle('openJournal').ok, false);
  assert.match(missing.store.snapshot().lastAction.text, /No trades yet/);
  const fine = setup();
  assert.deepEqual(fine.commands.handle('openLogs'), { ok: true });
  assert.deepEqual(fine.effects.opened, ['logs']);
});

test('setup label, resize and quit', () => {
  const { commands, store, effects } = setup();
  assert.deepEqual(commands.handle('setSetupLabel', { label: 'Sweep' }), { ok: true });
  assert.equal(store.snapshot().setupLabel, 'Sweep');
  assert.equal(commands.handle('setSetupLabel', { label: 'nope' }).ok, false);
  assert.equal(commands.handle('resize', { height: 'tall' }).ok, false);
  commands.handle('resize', { height: 420 });
  assert.deepEqual(effects.resized, [420]);
  commands.handle('quit');
  assert.equal(effects.quit, true);
});

test('openDashboard opens (or focuses) the dashboard window', () => {
  const { commands, effects } = setup();
  assert.deepEqual(commands.handle('openDashboard'), { ok: true });
  assert.deepEqual(effects.windows, ['dashboard']);
});
