import { MODE_LABELS, price } from '../format.js';

export default function Header({ mode, symbol, feed, menuOpen, onToggleMenu }) {
  const feedText = feed.ok ? (feed.markStale ? 'mark stale' : feed.network) : feed.status === 'error' ? 'reconnecting' : 'connecting';
  return (
    <header className="header drag">
      <button
        className={`menu-button no-drag ${menuOpen ? 'open' : ''}`}
        onClick={onToggleMenu}
        title="Menu"
        aria-label="Menu"
        aria-expanded={menuOpen}
      >
        ☰
      </button>
      <span className={`mode mode-${mode}`}>{MODE_LABELS[mode] ?? mode}</span>
      <span className="symbol">{symbol}</span>
      <span className={`mark ${feed.markStale ? 'bad' : ''}`}>{price(feed.mark)}</span>
      <span className={`dot ${feed.ok && !feed.markStale ? 'dot-ok' : 'dot-bad'}`} title={feed.error ?? feedText} />
      <button className="close no-drag" onClick={() => window.ptk.command('quit')} title="Quit PTK Terminal" aria-label="Quit">
        ×
      </button>
    </header>
  );
}
