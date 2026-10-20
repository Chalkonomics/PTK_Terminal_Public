import { useMemo, useState } from 'react';
import { Activity, Flame, Percent, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cumulative, formatValue, greenStreak, groupByDay, summarize } from '../lib/calendar.js';
import { toneText } from './tone.js';

function StatCard({ title, icon: Icon, children }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
        <Icon className="text-muted-foreground size-4" aria-hidden />
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

/** Running total for the period. Hovering shows the value after each trade. */
function Sparkline({ points, unit }) {
  const [hover, setHover] = useState(null);
  if (!points.length) return null;
  const W = 112;
  const H = 44;
  const values = [0, ...points];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => (i / (values.length - 1)) * W;
  const y = (v) => H - 2 - ((v - min) / span) * (H - 4);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.at(-1);
  const stroke = last >= 0 ? 'var(--profit)' : 'var(--loss)';

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Running total, ending ${formatValue(last, unit)}`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(values.length - 1, Math.round(((e.clientX - rect.left) / rect.width) * (values.length - 1)))));
        }}>
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="2 3" />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && <circle cx={x(hover)} cy={y(values[hover])} r="4" fill={stroke} stroke="var(--card)" strokeWidth="2" />}
      </svg>
      {hover !== null && (
        <div className="bg-popover text-popover-foreground pointer-events-none absolute -top-7 right-0 rounded-md border px-2 py-0.5 text-xs whitespace-nowrap shadow">
          {hover === 0 ? 'start' : `after trade ${hover}`}: {formatValue(values[hover], unit)}
        </div>
      )}
    </div>
  );
}

/** Win % as a thin bar: wins vs losses, BE left out. */
function WinBar({ wins, losses }) {
  const total = wins + losses;
  if (!total) return null;
  return (
    <div className="mt-3 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
      <div className="bg-profit rounded-full" style={{ width: `${(wins / total) * 100}%` }} />
      <div className="bg-loss rounded-full" style={{ width: `${(losses / total) * 100}%` }} />
    </div>
  );
}

export default function StatCards({ trades, view, loading }) {
  const s = useMemo(() => summarize(trades, view), [trades, view]);
  const points = useMemo(() => cumulative(trades, view), [trades, view]);
  const streak = useMemo(() => greenStreak(groupByDay(trades), view), [trades, view]);
  const placeholder = loading ? '…' : '—';

  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Period stats">
      <StatCard title={`Net ${view.unit === 'R' ? 'R' : 'P&L'} · ${view.fees === 'net' ? 'after fees' : 'before fees'}`} icon={TrendingUp}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className={`text-3xl font-semibold ${s.count ? toneText(s.tone) : ''}`}>{s.count ? formatValue(s.total, view.unit) : placeholder}</div>
            {s.missing > 0 && <div className="text-muted-foreground mt-1 text-xs">{s.missing} trade{s.missing > 1 ? 's' : ''} without data</div>}
          </div>
          <Sparkline points={points} unit={view.unit} />
        </div>
      </StatCard>

      <StatCard title="Win %" icon={Percent}>
        <div className="text-3xl font-semibold">{s.winPct === null ? placeholder : `${s.winPct.toFixed(1)}%`}</div>
        <div className="text-muted-foreground mt-1 text-xs">
          {s.wins}W · {s.losses}L{s.scratches ? ` · ${s.scratches} BE` : ''}
        </div>
        <WinBar wins={s.wins} losses={s.losses} />
      </StatCard>

      <StatCard title="Trades" icon={Activity}>
        <div className="text-3xl font-semibold">{loading ? placeholder : s.count}</div>
        <div className="text-muted-foreground mt-1 text-xs">taken, missed setups excluded</div>
      </StatCard>

      <StatCard title="Green-day streak" icon={Flame}>
        <div className="text-3xl font-semibold">{loading ? placeholder : streak}</div>
        <div className="text-muted-foreground mt-1 text-xs">consecutive positive trading days</div>
      </StatCard>
    </section>
  );
}
