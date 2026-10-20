import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createClipboardWatcher } from './clipboard.js';
import { createMarket } from './market.js';
import { createStore } from './store.js';
import { createActions } from './actions.js';
import { registerHotkeys } from './hotkeys.js';
import { createExecutor } from './orders.js';
import { createJournal } from './journal.js';
import { createNotionSync, loadNotionEnv } from './notion.js';
import { createActivityLog } from './activityLog.js';
import { ARM_LIVE_FLAG, createCommands } from './commands.js';
import { loadUiPrefs, saveConfigPatch, saveUiPrefs } from './session.js';
import { createWindows, windowSpecs } from './windows.js';
import { createTradesReader, isNotionUrl } from './dashboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PANEL_HZ = 5;
const PANEL_WIDTH = 340;

// Two instances would fight over the global hotkeys.
if (!app.requestSingleInstanceLock()) app.quit();

// Everything the app reports goes to logs/ptk-YYYY-MM-DD.log as well as the console.
const activity = createActivityLog({ dir: path.join(ROOT, 'logs') });
const log = activity.log;
// Monitor only: records crashes (including unhandled rejections) without changing what happens next.
process.on('uncaughtExceptionMonitor', (err, origin) => log(`[crash] ${origin}: ${err?.stack ?? err}`));

let config;
try {
  config = loadConfig(ROOT);
} catch (err) {
  app.whenReady().then(() => {
    log(`[config] ${err.message}`);
    dialog.showErrorBox('PTK Terminal — configuration error', err.message);
    app.quit();
  });
}

// Extra windows open at the last mode switch, passed to the relaunched app as --reopen=name.
const REOPEN_PREFIX = '--reopen=';

let windows = null;
let tradesReader = null;
let watcher = null;
let market = null;
let store = null;
let executor = null;
let journal = null;
let journalTimer = null;
let panelTimer = null;
let prefs = loadUiPrefs(ROOT);

function createWindowManager() {
  windows = createWindows({
    BrowserWindow,
    screen,
    rootDir: ROOT,
    devUrl: process.env.VITE_DEV_SERVER_URL,
    specs: windowSpecs({ panelWidth: PANEL_WIDTH, alwaysOnTop: prefs.alwaysOnTop }),
    onCreated(name, win) {
      if (name !== 'panel') return;
      win.webContents.on('render-process-gone', stopPanelUpdates);
      win.on('close', stopPanelUpdates);
    },
  });
}

function stopPanelUpdates() {
  clearInterval(panelTimer);
  panelTimer = null;
}

function pushPanelState() {
  // The window can be torn down between ticks during shutdown; send() skips it then.
  windows.send('panel', 'state', store.snapshot());
}

function playSound(kind) {
  windows.send('panel', 'sound', { kind, file: config.sounds[kind] });
}

function registerIpc() {
  const commands = createCommands({
    config,
    store,
    log,
    saveConfigPatch: (patch) => saveConfigPatch(ROOT, patch),
    saveUiPrefs: (next) => saveUiPrefs(ROOT, (prefs = next)),
    relaunch: ({ armLive }) => {
      // The new instance re-runs every startup check. Arming only carries over when Live was chosen from the menu.
      const args = process.argv.slice(1).filter((a) => a !== ARM_LIVE_FLAG && !a.startsWith(REOPEN_PREFIX));
      const reopen = windows.openExtras().map((name) => REOPEN_PREFIX + name);
      app.relaunch({ args: [...args, ...reopen, ...(armLive ? [ARM_LIVE_FLAG] : [])] });
      app.quit();
    },
    open: (target) => {
      if (target === 'journal' && !fs.existsSync(config.logPath)) return 'No trades yet: trades.csv is created on the first press';
      shell.openPath(target === 'journal' ? config.logPath : activity.dir).then((err) => err && log(`[command] open ${target}: ${err}`));
      return null;
    },
    openWindow: (name) => windows.open(name),
    setAlwaysOnTop: (on) => windows.get('panel')?.setAlwaysOnTop(on),
    resize: (height) => windows.get('panel')?.setContentSize(PANEL_WIDTH, Math.min(Math.max(Math.ceil(height), 80), 1000)),
    quit: () => app.quit(),
  });
  // Each channel only answers the window it belongs to.
  ipcMain.handle('command', (e, name, args) => (windows.isFrom('panel', e) ? commands.handle(name, args) : { ok: false, error: 'not allowed from this window' }));
  ipcMain.handle('dashboard:trades', async (e, range) => {
    if (!windows.isFrom('dashboard', e)) return { ok: false, error: 'not allowed from this window' };
    try {
      return { ok: true, trades: await tradesReader.read(range) };
    } catch (err) {
      log(`[dashboard] reading trades failed: ${err.message}`);
      return { ok: false, error: err.name === 'TimeoutError' ? 'Notion did not respond' : err.message };
    }
  });
  ipcMain.handle('dashboard:openNotion', (e, url) => {
    if (!windows.isFrom('dashboard', e) || !isNotionUrl(url)) return { ok: false, error: 'not a Notion link' };
    shell.openExternal(url).catch((err) => log(`[dashboard] open ${url}: ${err.message}`));
    return { ok: true };
  });
}

app.whenReady().then(() => {
  if (!config) return;

  watcher = createClipboardWatcher({
    readText: () => clipboard.readText(),
    pollMs: config.clipboardPollMs,
  });
  watcher.start();

  market = createMarket({ config, log });
  market.start();

  // Testnet and live only: dry run never loads the key.
  if (config.mode !== 'dryRun') {
    executor = createExecutor({ config, rootDir: ROOT, log });
    executor.init();
  }

  createWindowManager();
  const notion = createNotionSync({
    config,
    log,
    rootDir: ROOT,
    env: loadNotionEnv(ROOT),
    // A trade's result is in Notion: the dashboard's cached view is out of date.
    onWrite: () => {
      tradesReader.invalidate();
      windows.send('dashboard', 'trades-changed');
    },
  });
  tradesReader = createTradesReader({ query: (range) => notion.queryTrades(range) });
  journal = createJournal({
    config,
    log,
    rootDir: ROOT,
    marketSnapshot: () => market.snapshot(),
    fetchFills: (startTime) => market.fetchFills(startTime),
    mirror: notion,
  });
  // 1Hz: MAE/MFE sampling, close detection, retrying writes the CSV or Notion refused.
  journalTimer = setInterval(() => {
    journal.tick();
    notion.tick();
  }, 1000);

  // LIVE starts disarmed unless this launch is the relaunch from choosing Live in the menu.
  const liveArmed = config.mode === 'live' && process.argv.includes(ARM_LIVE_FLAG);
  store = createStore({ config, watcher, market, execution: executor?.status ?? null, journal, notion, prefs, liveArmed });
  registerIpc();

  windows.open('panel');
  panelTimer = setInterval(pushPanelState, 1000 / PANEL_HZ);
  for (const arg of process.argv) {
    if (arg.startsWith(REOPEN_PREFIX) && arg.slice(REOPEN_PREFIX.length) === 'dashboard') windows.open('dashboard');
  }

  const actions = createActions({ config, store, market, executor, journal, playSound, log });
  const hotkeys = registerHotkeys({ globalShortcut, config, handlers: actions });
  store.setHotkeys(hotkeys);
  for (const h of hotkeys) {
    log(`[hotkey] ${h.action} ${h.accelerator}: ${h.registered ? 'registered' : `FAILED${h.error ? ` (${h.error})` : ' (owned by another app)'}`}`);
  }

  log(`[ptk] started in ${config.mode} mode${config.mode === 'live' ? (liveArmed ? ' (armed from menu)' : ' (DISARMED until confirmed)') : ''} (log: ${activity.file})`);
});

app.on('before-quit', stopPanelUpdates);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPanelUpdates();
  clearInterval(journalTimer);
  watcher?.stop();
  market?.stop();
});

app.on('window-all-closed', () => app.quit());
