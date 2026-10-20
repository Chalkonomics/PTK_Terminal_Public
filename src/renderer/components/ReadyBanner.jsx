const HEADLINE = { green: 'READY', amber: 'READY', red: 'BLOCKED' };

export default function ReadyBanner({ ready, busy, needsArm }) {
  const { level, direction, failed, warnings } = ready;
  return (
    <section className={`ready ready-${busy ? 'busy' : needsArm ? 'arm' : level}`} role="status">
      <div className="ready-head">
        <span className="ready-light" />
        <span className="ready-title">{busy ? 'WORKING…' : needsArm ? 'LIVE · DISARMED' : HEADLINE[level]}</span>
        {direction && !busy && !needsArm && <span className={`dir dir-${direction}`}>{direction.toUpperCase()}</span>}
      </div>
      {needsArm ? (
        <div className="ready-detail">
          Hotkeys won't place orders until you confirm live trading for this session. Panic still works.
          <button className="arm no-drag" onClick={() => window.ptk.command('armLive')}>Arm LIVE</button>
        </div>
      ) : (
        failed && (
          <div className="ready-detail">
            <strong>{failed.label}:</strong> {failed.detail}
          </div>
        )
      )}
      {!failed && warnings.length > 0 && (
        <ul className="ready-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
