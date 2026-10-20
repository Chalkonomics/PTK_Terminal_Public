import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindows, usableBounds, windowSpecs } from '../src/main/windows.js';
import { createTradesReader, isNotionUrl } from '../src/main/dashboard.js';

const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

/** A stand-in for Electron's BrowserWindow that records what was asked of it. */
function fakeElectron() {
  const created = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.destroyed = false;
      this.focused = 0;
      this.webContents = { isDestroyed: () => this.destroyed, sent: [], send: (ch, p) => this.webContents.sent.push([ch, p]) };
      created.push(this);
    }
    loadURL(url) { this.loaded = url; }
    loadFile(file) { this.loaded = file; }
    on(event, fn) { this.handlers[event] = fn; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    focus() { this.focused += 1; }
    getBounds() { return { x: 100, y: 50, width: 1200, height: 800 }; }
    close() {
      this.handlers.close?.();
      this.destroyed = true;
      this.handlers.closed?.();
    }
  }
  return { BrowserWindow, created };
}

function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return { files, readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); }, writeFileSync: (p, d) => files.set(p, String(d)) };
}

function manager({ devUrl, fs = memFs() } = {}) {
  const electron = fakeElectron();
  const windows = createWindows({
    BrowserWindow: electron.BrowserWindow,
    screen: { getAllDisplays: () => [DISPLAY] },
    rootDir: 'C:/app',
    devUrl,
    specs: windowSpecs({ panelWidth: 340, alwaysOnTop: true }),
    fs,
  });
  return { windows, electron, fs };
}

test('each window gets its own preload and the sandbox settings', () => {
  const { windows, electron } = manager();
  windows.open('panel');
  windows.open('dashboard');
  const [panel, dashboard] = electron.created;
  assert.match(panel.options.webPreferences.preload, /preloads[\\/]panel\.cjs$/);
  assert.match(dashboard.options.webPreferences.preload, /preloads[\\/]dashboard\.cjs$/);
  for (const w of electron.created) {
    assert.equal(w.options.webPreferences.contextIsolation, true);
    assert.equal(w.options.webPreferences.nodeIntegration, false);
    assert.equal(w.options.webPreferences.sandbox, true);
  }
  assert.equal(panel.options.alwaysOnTop, true);
  assert.equal(dashboard.options.alwaysOnTop, undefined);
  assert.equal(panel.options.webPreferences.autoplayPolicy, 'no-user-gesture-required');
});

test('pages load from the dev server or the build', () => {
  const dev = manager({ devUrl: 'http://localhost:5173' });
  dev.windows.open('panel');
  dev.windows.open('dashboard');
  assert.deepEqual(dev.electron.created.map((w) => w.loaded), ['http://localhost:5173/index.html', 'http://localhost:5173/dashboard.html']);
  const built = manager();
  built.windows.open('dashboard');
  assert.match(built.electron.created[0].loaded, /dist[\\/]renderer[\\/]dashboard\.html$/);
});

test('opening an open window focuses it instead of making a second one', () => {
  const { windows, electron } = manager();
  windows.open('dashboard');
  windows.open('dashboard');
  assert.equal(electron.created.length, 1);
  assert.equal(electron.created[0].focused, 1);
  electron.created[0].close();
  assert.equal(windows.get('dashboard'), null);
  windows.open('dashboard');
  assert.equal(electron.created.length, 2);
});

test('send() reaches only open windows; isFrom() checks the sender', () => {
  const { windows, electron } = manager();
  windows.send('dashboard', 'trades-changed');
  windows.open('panel');
  windows.open('dashboard');
  windows.send('dashboard', 'trades-changed');
  const [panel, dashboard] = electron.created;
  assert.deepEqual(dashboard.webContents.sent, [['trades-changed', undefined]]);
  assert.deepEqual(panel.webContents.sent, []);
  assert.equal(windows.isFrom('dashboard', { sender: dashboard.webContents }), true);
  assert.equal(windows.isFrom('panel', { sender: dashboard.webContents }), false);
  assert.deepEqual(windows.openExtras(), ['dashboard']);
});

test('the dashboard remembers where it was, unless that is off-screen now', () => {
  const { windows, electron, fs } = manager();
  windows.open('dashboard').close();
  const saved = JSON.parse(fs.files.get('C:\\app\\window-state.json') ?? fs.files.get('C:/app/window-state.json'));
  assert.deepEqual(saved.dashboard, { x: 100, y: 50, width: 1200, height: 800 });
  windows.open('dashboard');
  assert.equal(electron.created[1].options.x, 100);

  assert.equal(usableBounds({ x: 3000, y: 50, width: 1200, height: 800 }, [DISPLAY]), null, 'monitor unplugged');
  assert.equal(usableBounds({ x: 'a' }, [DISPLAY]), null);
  assert.equal(usableBounds(undefined, [DISPLAY]), null);
});

test('unknown windows are refused', () => {
  assert.throws(() => manager().windows.open('settings'), /unknown window/);
});

// --- Trades reader (main-process cache for the dashboard) ---

test('reads are cached per range until invalidated or refreshed', async () => {
  const calls = [];
  const reader = createTradesReader({ query: async (r) => (calls.push(r), [{ id: String(calls.length) }]) });
  const range = { from: '2026-10-01T00:00:00+01:00', to: null };
  assert.deepEqual(await reader.read(range), [{ id: '1' }]);
  assert.deepEqual(await reader.read(range), [{ id: '1' }]);
  assert.deepEqual(calls, [{ from: '2026-09-30T23:00:00.000Z', to: null }], 'normalised to UTC');
  reader.invalidate();
  assert.deepEqual(await reader.read(range), [{ id: '2' }]);
  assert.deepEqual(await reader.read({ ...range, refresh: true }), [{ id: '3' }]);
});

test('a failed read is not cached', async () => {
  let fail = true;
  const reader = createTradesReader({ query: async () => { if (fail) throw new Error('Notion 503'); return []; } });
  await assert.rejects(reader.read({}), /503/);
  fail = false;
  assert.deepEqual(await reader.read({}), []);
});

test('bad ranges are rejected before reaching Notion', async () => {
  const reader = createTradesReader({ query: async () => assert.fail('should not query') });
  await assert.rejects(reader.read({ from: 'yesterday' }), /bad date range/);
  await assert.rejects(reader.read({ to: 42 }), /bad date range/);
});

test('only https Notion links can be opened', () => {
  assert.equal(isNotionUrl('https://www.notion.so/abc123'), true);
  assert.equal(isNotionUrl('https://app.notion.com/p/abc'), true);
  assert.equal(isNotionUrl('http://www.notion.so/abc'), false);
  assert.equal(isNotionUrl('https://notion.so.evil.com/abc'), false);
  assert.equal(isNotionUrl('file:///C:/Windows/system32/calc.exe'), false);
  assert.equal(isNotionUrl('not a url'), false);
});
