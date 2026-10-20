// Global shortcut registration. globalShortcut.register() returns false (it does
// not throw) when another app owns the combo, so every result is checked and
// reported; a dead hotkey must be visible before it's needed.

/**
 * @param {object} opts
 * @param {Electron.GlobalShortcut} opts.globalShortcut
 * @param {object} opts.config
 * @param {{ long: Function, short: Function, panic: Function }} opts.handlers
 * @returns {{ action: string, accelerator: string, registered: boolean, error?: string }[]}
 */
export function registerHotkeys({ globalShortcut, config, handlers }) {
  const bindings = [
    ['long', config.hotkeyLong],
    ['short', config.hotkeyShort],
    ['panic', config.hotkeyPanic],
  ];
  return bindings.map(([action, accelerator]) => {
    try {
      const registered = globalShortcut.register(accelerator, handlers[action]);
      return { action, accelerator, registered };
    } catch (err) {
      // Malformed accelerator strings throw.
      return { action, accelerator, registered: false, error: err.message };
    }
  });
}
