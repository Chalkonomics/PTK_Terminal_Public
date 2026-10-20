import { MODES } from './session.js';

// The single command channel from the panel. The renderer can only *ask*; every
// command is whitelisted and validated here, and nothing in this list can place
// an order. Electron-specific effects are injected so the logic is testable.

export const ARM_LIVE_FLAG = '--arm-live';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {(patch: object) => void} deps.saveConfigPatch   throws on invalid config
 * @param {(prefs: object) => void} deps.saveUiPrefs
 * @param {(opts: { armLive: boolean }) => void} deps.relaunch
 * @param {(target: 'journal' | 'logs') => string | null} deps.open   returns an error message or null
 * @param {(name: 'dashboard') => void} deps.openWindow   opens the window or brings it to the front
 * @param {(on: boolean) => void} deps.setAlwaysOnTop
 * @param {(height: number) => void} deps.resize
 * @param {() => void} deps.quit
 * @param {(line: string) => void} [deps.log]
 */
export function createCommands({ config, store, saveConfigPatch, saveUiPrefs, relaunch, open, openWindow, setAlwaysOnTop, resize, quit, log = console.log }) {
  const ok = (extra = {}) => ({ ok: true, ...extra });
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

  const handlers = {
    setSetupLabel({ label } = {}) {
      if (!config.setupLabels.includes(label)) return fail('unknown setup label');
      store.setSetupLabel(label);
      return ok();
    },

    setMode({ mode, confirmed = false } = {}) {
      if (!MODES.includes(mode)) return fail(`unknown mode ${mode}`);
      if (mode === config.mode) return ok();
      // Re-checked here rather than trusting the menu's greyed-out state.
      const blockers = store.switchBlockers();
      if (blockers.length) {
        const text = `Mode switch blocked: ${blockers.join(', ')}`;
        store.setLastAction('info', text);
        return fail(text);
      }
      if (mode === 'live' && !confirmed) return fail('confirmation required', { needsConfirm: true });
      try {
        saveConfigPatch({ mode });
      } catch (err) {
        store.setLastAction('error', `Mode switch failed: ${err.message}`);
        return fail(err.message);
      }
      log(`[mode] switching ${config.mode} -> ${mode}; relaunching`);
      // Choosing Live from the menu is the session's confirmation, so it starts armed.
      relaunch({ armLive: mode === 'live' });
      return ok({ relaunching: true });
    },

    armLive() {
      if (config.mode !== 'live') return fail('not in live mode');
      store.armLive();
      store.setLastAction('info', 'LIVE armed for this session');
      log('[mode] LIVE armed for this session');
      return ok();
    },

    openJournal() {
      const error = open('journal');
      if (error) store.setLastAction('info', error);
      return error ? fail(error) : ok();
    },

    openLogs() {
      const error = open('logs');
      if (error) store.setLastAction('info', error);
      return error ? fail(error) : ok();
    },

    openDashboard() {
      openWindow('dashboard');
      return ok();
    },

    toggleAlwaysOnTop() {
      const alwaysOnTop = !store.prefs.alwaysOnTop;
      store.setPrefs({ alwaysOnTop });
      setAlwaysOnTop(alwaysOnTop);
      saveUiPrefs(store.prefs);
      return ok({ alwaysOnTop });
    },

    toggleCompact() {
      const compact = !store.prefs.compact;
      store.setPrefs({ compact });
      saveUiPrefs(store.prefs);
      return ok({ compact });
    },

    resize({ height } = {}) {
      if (!Number.isFinite(height)) return fail('bad height');
      resize(height);
      return ok();
    },

    quit() {
      quit();
      return ok();
    },
  };

  return {
    names: Object.keys(handlers),
    handle(name, args) {
      if (!Object.hasOwn(handlers, name)) return fail(`unknown command ${String(name)}`);
      try {
        return handlers[name](args && typeof args === 'object' ? args : {});
      } catch (err) {
        log(`[command] ${name} failed: ${err.message}`);
        return fail(err.message);
      }
    },
  };
}
