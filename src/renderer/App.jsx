import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import Menu from './components/Menu.jsx';
import ReadyBanner from './components/ReadyBanner.jsx';
import TradePlan from './components/TradePlan.jsx';
import AccountPanel from './components/AccountPanel.jsx';
import { Checks, HotkeyAlert, Hotkeys, JournalStatus, LastAction, NotionStatus, SetupPicker } from './components/Footer.jsx';
import { usd } from './format.js';
import { playSound } from './sounds.js';

function useBackendState() {
  const [state, setState] = useState(null);
  useEffect(() => window.ptk.onState(setState), []);
  useEffect(() => window.ptk.onSound(playSound), []);
  return state;
}

// Keeps the frameless window exactly as tall as its content.
function useAutoHeight(ref) {
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => window.ptk.command('resize', { height: entry.target.offsetHeight }));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
}

// One line for compact view: what a press would do right now.
function CompactSummary({ plan, position }) {
  if (position) {
    const side = position.size > 0 ? 'LONG' : 'SHORT';
    return (
      <p className="compact-line">
        <span className={`dir dir-${side.toLowerCase()}`}>{side}</span> {Math.abs(position.size)} ·{' '}
        <span className={position.unrealizedPnl >= 0 ? 'ok' : 'bad'}>{usd(position.unrealizedPnl)}</span> ·{' '}
        {position.stop ? <span className={position.stop.coversSize ? 'ok' : 'bad'}>stop {position.stop.triggerPx}</span> : <span className="bad strong">NO STOP</span>}
      </p>
    );
  }
  if (!plan) return <p className="compact-line muted">Copy a stop price</p>;
  return (
    <p className="compact-line">
      <strong>{plan.sizeStr} BTC</strong> · risk {usd(plan.riskUsd)} · fees <span className={plan.feesR > 0.5 ? 'warn' : ''}>{plan.feesR.toFixed(2)}R</span>
    </p>
  );
}

export default function App() {
  const state = useBackendState();
  const root = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useAutoHeight(root);

  if (!state) {
    return (
      <div ref={root} className="panel">
        <div className="waiting drag">Connecting…</div>
      </div>
    );
  }

  const compact = state.menu.compact;
  return (
    <div ref={root} className={`panel ${state.mode === 'live' ? 'panel-live' : ''} ${compact ? 'panel-compact' : ''} ${menuOpen ? 'menu-open' : ''}`}>
      <Header mode={state.mode} symbol={state.symbol} feed={state.feed} menuOpen={menuOpen} onToggleMenu={() => setMenuOpen((o) => !o)} />
      {menuOpen && <Menu mode={state.mode} menu={state.menu} onClose={closeMenu} />}
      <HotkeyAlert hotkeys={state.hotkeys} />
      <ReadyBanner ready={state.ready} busy={state.busy} needsArm={state.needsArm} />
      {compact ? (
        <CompactSummary plan={state.plan} position={state.account?.position} />
      ) : (
        <>
          <TradePlan clipboard={state.clipboard} plan={state.plan} riskPctTarget={state.riskPctTarget} />
          <AccountPanel account={state.account} accountless={state.accountless} expectedLeverage={state.expectedLeverage} execution={state.execution} />
          <SetupPicker labels={state.setupLabels} selected={state.setupLabel} />
          <LastAction action={state.lastAction} />
          <JournalStatus journal={state.journal} />
          <NotionStatus notion={state.notion} />
          <Checks checks={state.ready.checks} />
          <Hotkeys hotkeys={state.hotkeys} />
        </>
      )}
    </div>
  );
}
