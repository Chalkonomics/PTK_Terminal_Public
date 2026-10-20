import { age, pct, price, usd, whole } from '../format.js';

// Fees above half an R are highlighted: a scratch trade then costs more than half the risk.
const FEES_WARN_R = 0.5;

export default function TradePlan({ clipboard, plan, riskPctTarget }) {
  const stopCell = clipboard.value != null
    ? <dd>{whole(clipboard.value)}</dd>
    : <dd className="bad" title={clipboard.raw ?? ''}>{clipboard.raw ? `"${clipboard.raw}"` : '—'}</dd>;

  // Risk should read the target (1.00%) on every trade; anything noticeably under is flagged.
  const riskOk = plan && plan.riskPct <= riskPctTarget + 1e-9 && plan.riskPct >= riskPctTarget * 0.98;

  return (
    <section>
      <h2>Next trade</h2>
      <dl className="rows">
        <dt>Stop (clipboard)</dt>
        {stopCell}
        <dt>Stop age</dt>
        <dd className={clipboard.ageLevel}>{age(clipboard.ageMs)}</dd>
        {clipboard.value == null && clipboard.error && (
          <>
            <dt />
            <dd className="bad small">{clipboard.error}</dd>
          </>
        )}
        <dt>Distance</dt>
        <dd>{plan ? `${whole(plan.stopDistance)} · ${pct(plan.stopDistancePct)}` : '—'}</dd>
        <dt>Size</dt>
        <dd className="strong">{plan ? `${plan.sizeStr} BTC` : '—'}</dd>
        <dt>Notional / margin</dt>
        <dd>{plan ? `${whole(plan.notional)} / ${whole(plan.margin)}` : '—'}</dd>
        <dt>Risk</dt>
        <dd className={plan ? (riskOk ? 'ok' : 'warn') : ''}>
          {plan ? `${usd(plan.riskUsd)} · ${pct(plan.riskPct)}` : '—'}
        </dd>
        <dt>Fees if stopped</dt>
        <dd
          className={plan && plan.feesR > FEES_WARN_R ? 'warn' : ''}
          title={plan ? `Round-trip taker fees at ${(plan.takerFeeRate * 100).toFixed(3)}% per side${plan.feeRateAssumed ? ' (assumed base rate)' : ''}` : ''}
        >
          {plan ? `≈${usd(plan.feesUsd)} · ${plan.feesR.toFixed(2)}R${plan.feeRateAssumed ? '*' : ''}` : '—'}
        </dd>
        <dt>Entry limit / liq</dt>
        <dd className="muted">{plan ? `${price(plan.entryLimitPx)} / ~${whole(plan.liqPx)}` : '—'}</dd>
      </dl>
    </section>
  );
}
