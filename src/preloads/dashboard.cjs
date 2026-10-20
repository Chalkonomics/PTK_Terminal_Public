const { contextBridge, ipcRenderer } = require('electron');

// The trades dashboard can read trades and open a trade's Notion page. Nothing
// else: no command channel, so it can't switch mode, quit or touch trading.
contextBridge.exposeInMainWorld('dashboard', {
  /** @param {{ from: string | null, to: string | null, refresh?: boolean }} range  ISO instants (null = unbounded); refresh skips the cache */
  getTrades: (range) => ipcRenderer.invoke('dashboard:trades', { from: range?.from ?? null, to: range?.to ?? null, refresh: range?.refresh === true }),
  openInNotion: (url) => ipcRenderer.invoke('dashboard:openNotion', String(url)),
  /** Called when a trade's result has been written to Notion, so the view should refetch. */
  onTradesChanged(callback) {
    const handler = () => callback();
    ipcRenderer.on('trades-changed', handler);
    return () => ipcRenderer.removeListener('trades-changed', handler);
  },
});
