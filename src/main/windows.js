import nodeFs from 'node:fs';
import path from 'node:path';

// Opens the app's windows by name. Each window has its own page and its own
// preload, and a preload exposes only what that window needs: only the panel can
// send commands, so no other window can switch mode or quit.
//
// Electron is injected so the open/focus/bounds logic is testable.

const BASE_WEB_PREFERENCES = Object.freeze({ contextIsolation: true, nodeIntegration: false, sandbox: true });

/** Window name → page, preload and BrowserWindow options. */
export function windowSpecs({ panelWidth, alwaysOnTop }) {
  return {
    panel: {
      page: 'index.html',
      preload: 'src/preloads/panel.cjs',
      options: {
        width: panelWidth,
        height: 600,
        frame: false,
        alwaysOnTop,
        resizable: false,
        maximizable: false,
        backgroundColor: '#0d1117',
      },
      // Sounds are triggered by hotkeys pressed in another app, never by a click here.
      webPreferences: { autoplayPolicy: 'no-user-gesture-required' },
    },
    dashboard: {
      page: 'dashboard.html',
      preload: 'src/preloads/dashboard.cjs',
      options: {
        title: 'PTK Trades',
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#09090b',
        autoHideMenuBar: true,
      },
      rememberBounds: true,
    },
  };
}

/** Saved bounds, if they are numbers and still overlap a connected display. */
export function usableBounds(saved, displays) {
  if (!saved || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(saved[k]))) return null;
  const visible = displays.some(({ workArea: a }) =>
    saved.x < a.x + a.width - 50 && saved.x + saved.width > a.x + 50 && saved.y < a.y + a.height - 50 && saved.y + saved.height > a.y);
  return visible ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null;
}

/**
 * @param {object} deps
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {{ getAllDisplays(): { workArea: { x: number, y: number, width: number, height: number } }[] }} deps.screen
 * @param {string} deps.rootDir
 * @param {string | undefined} deps.devUrl      Vite dev server, when running `npm run dev`
 * @param {ReturnType<typeof windowSpecs>} deps.specs
 * @param {(name: string, win: object) => void} [deps.onCreated]   wire per-window events
 * @param {typeof nodeFs} [deps.fs]
 */
export function createWindows({ BrowserWindow, screen, rootDir, devUrl, specs, onCreated = () => {}, fs = nodeFs }) {
  const boundsFile = path.join(rootDir, 'window-state.json');
  const open = new Map();

  function readBounds() {
    try {
      return JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function saveBounds(name, bounds) {
    try {
      fs.writeFileSync(boundsFile, JSON.stringify({ ...readBounds(), [name]: bounds }, null, 2) + '\n');
    } catch {
      // Window positions are a convenience; never fail over them.
    }
  }

  function create(name) {
    const spec = specs[name];
    if (!spec) throw new Error(`unknown window ${name}`);
    const saved = spec.rememberBounds ? usableBounds(readBounds()[name], screen.getAllDisplays()) : null;
    const win = new BrowserWindow({
      ...spec.options,
      ...saved,
      webPreferences: { ...BASE_WEB_PREFERENCES, ...spec.webPreferences, preload: path.join(rootDir, spec.preload) },
    });
    open.set(name, win);

    if (devUrl) win.loadURL(new URL(spec.page, devUrl.endsWith('/') ? devUrl : `${devUrl}/`).href);
    else win.loadFile(path.join(rootDir, 'dist/renderer', spec.page));

    if (spec.rememberBounds) win.on('close', () => saveBounds(name, win.getBounds()));
    win.on('closed', () => open.delete(name));
    onCreated(name, win);
    return win;
  }

  return {
    /** Opens the window, or brings it to the front if it is already open. */
    open(name) {
      const existing = open.get(name);
      if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return existing;
      }
      return create(name);
    },
    /** The window if it is open and its page is alive, else null. */
    get(name) {
      const win = open.get(name);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
      return win;
    },
    /** Sends to a window's page if it is open; a no-op otherwise. */
    send(name, channel, payload) {
      this.get(name)?.webContents.send(channel, payload);
    },
    /** Whether an IPC message came from the named window. */
    isFrom(name, event) {
      return this.get(name)?.webContents === event.sender;
    },
    /** Names of the open windows other than the panel, for reopening after a relaunch. */
    openExtras() {
      return [...open.keys()].filter((n) => n !== 'panel' && this.get(n));
    },
  };
}
