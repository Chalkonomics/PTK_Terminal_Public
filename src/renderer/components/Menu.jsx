import { useEffect, useRef, useState } from 'react';
import { MODE_LABELS } from '../format.js';

const MODES = ['dryRun', 'testnet', 'live'];

// The ☰ dropdown. It only sends requests; the main process validates every one,
// including re-checking whether a mode switch is allowed right now.
export default function Menu({ mode, menu, onClose }) {
  const [confirmLive, setConfirmLive] = useState(false);
  const [switching, setSwitching] = useState(null);
  const ref = useRef(null);
  const blocked = menu.switchBlockers.length > 0;
  const blockedText = `Can't switch now: ${menu.switchBlockers.join(', ')}`;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.menu-button')) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  async function chooseMode(target, confirmed = false) {
    if (target === mode || switching) return;
    const result = await window.ptk.command('setMode', { mode: target, confirmed });
    if (result.needsConfirm) setConfirmLive(true);
    else if (result.relaunching) setSwitching(target);
    else if (!result.ok) onClose(); // the reason is shown under Last action
  }

  const run = (name) => async () => {
    await window.ptk.command(name);
    if (name === 'openJournal' || name === 'openLogs' || name === 'openDashboard') onClose();
  };

  if (switching) {
    return (
      <nav className="menu" ref={ref}>
        <p className="menu-note">Switching to {MODE_LABELS[switching]}… restarting</p>
      </nav>
    );
  }

  return (
    <nav className="menu no-drag" ref={ref} aria-label="Menu">
      <div className="menu-heading">Mode</div>
      {MODES.map((m) => (
        <button
          key={m}
          className={`menu-item mode-option ${m === mode ? 'current' : ''}`}
          disabled={m !== mode && blocked}
          title={m !== mode && blocked ? blockedText : ''}
          onClick={() => chooseMode(m)}
        >
          <span className="check">{m === mode ? '✓' : ''}</span>
          <span className={`mode-dot mode-${m}`} /> {MODE_LABELS[m]}
          {m === 'live' && <span className="menu-hint">real money</span>}
        </button>
      ))}
      {blocked && <p className="menu-note warn">{blockedText}</p>}
      {confirmLive && (
        <div className="menu-confirm" role="alertdialog" aria-label="Confirm live trading">
          <p>Switch to <strong>LIVE</strong>? Hotkeys will place real orders with real money.</p>
          <div className="menu-confirm-actions">
            <button className="danger" onClick={() => chooseMode('live', true)}>Switch to LIVE</button>
            <button onClick={() => setConfirmLive(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="menu-sep" />
      <button className="menu-item" onClick={run('openDashboard')}><span className="check" />Trades dashboard</button>
      <button className="menu-item" onClick={run('openJournal')}><span className="check" />Open journal</button>
      <button className="menu-item" onClick={run('openLogs')}><span className="check" />Open log folder</button>
      <div className="menu-sep" />
      <button className="menu-item" onClick={run('toggleAlwaysOnTop')} role="menuitemcheckbox" aria-checked={menu.alwaysOnTop}>
        <span className="check">{menu.alwaysOnTop ? '✓' : ''}</span>Always on top
      </button>
      <button className="menu-item" onClick={run('toggleCompact')} role="menuitemcheckbox" aria-checked={menu.compact}>
        <span className="check">{menu.compact ? '✓' : ''}</span>Compact view
      </button>
      <div className="menu-sep" />
      <button className="menu-item" onClick={run('quit')}><span className="check" />Quit</button>
    </nav>
  );
}
