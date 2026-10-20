import { price, signed, usd, whole } from '../format.js';

function Position({ position }) {
  if (!position) return <dd className="muted">flat</dd>;
  const side = position.size > 0 ? 'LONG' : 'SHORT';
  const { stop } = position;
  return (
    <>
      <dd>
        <span className={`dir dir-${side.toLowerCase()}`}>{side}</span> {Math.abs(position.size)} @ {price(position.entryPx)}
      </dd>
      <dt>PnL</dt>
      <dd className={position.unrealizedPnl >= 0 ? 'ok' : 'bad'}>{signed(position.unrealizedPnl)}</dd>
      <dt>Stop</dt>
      {stop ? (
        <dd className={stop.coversSize ? 'ok' : 'bad'}>
          {whole(stop.triggerPx)} {stop.coversSize ? '✓' : '(partial!)'}
        </dd>
      ) : (
        <dd className="bad strong">NONE ATTACHED</dd>
      )}
    </>
  );
}

function ExecutionRow({ execution }) {
  if (!execution) return null;
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
  const expiry = execution.agentValidUntil ? `expires ${new Date(execution.agentValidUntil).toLocaleDateString()}` : 'no expiry';
  return (
    <>
      <dt>API wallet</dt>
      {execution.ready ? (
        <dd className="ok" title={execution.agentAddress}>{short(execution.agentAddress)} · {expiry}</dd>
      ) : (
        <dd className="bad" title={execution.error ?? ''}>not ready</dd>
      )}
    </>
  );
}

export default function AccountPanel({ account, accountless, expectedLeverage, execution }) {
  if (accountless) {
    return (
      <section>
        <h2>Account</h2>
        <p className="muted small">No accountAddress in config.json: position and margin not shown.</p>
      </section>
    );
  }
  if (!account) {
    return (
      <section>
        <h2>Account</h2>
        <p className="muted small">Loading…</p>
      </section>
    );
  }
  return (
    <section>
      <h2>Account</h2>
      <dl className="rows">
        <dt>Position</dt>
        <Position position={account.position} />
        <dt>Equity</dt>
        <dd title={`live: ${usd(account.liveEquity)}`}>
          {usd(account.equity)} <span className="muted small">{account.equityLabel}</span>
        </dd>
        <dt>Free collateral</dt>
        <dd>{usd(account.freeCollateral)}</dd>
        <dt>Leverage</dt>
        <dd className={account.leverageOk ? '' : 'bad'} title={account.leverageOk ? '' : `expected isolated ${expectedLeverage}x`}>
          {account.leverage.type} {account.leverage.value}x
        </dd>
        <ExecutionRow execution={execution} />
        {account.openOrders > 0 && (
          <>
            <dt>BTC orders</dt>
            <dd className="warn">{account.openOrders} resting</dd>
          </>
        )}
      </dl>
    </section>
  );
}
