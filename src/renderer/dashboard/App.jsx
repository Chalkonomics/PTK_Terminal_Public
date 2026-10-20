import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { addDays, addMonths, dayKey, firstOfMonth, groupByDay, monthGrid, monthOf, periodDays, PERIODS, startOfWeek } from './lib/calendar.js';
import { useTrades } from './useTrades.js';
import StatCards from './components/StatCards.jsx';
import CalendarCard from './components/CalendarCard.jsx';
import DayPanel from './components/DayPanel.jsx';

const DEFAULT_VIEW = { unit: 'R', fees: 'gross', period: 'thisMonth', layout: 'month' };
const PREFS_KEY = 'ptk-dashboard-view';

// The toggles are remembered on this PC; a missing or blocked localStorage just means defaults.
function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      unit: saved.unit === '$' ? '$' : 'R',
      fees: saved.fees === 'net' ? 'net' : 'gross',
      period: PERIODS.some((p) => p.id === saved.period) ? saved.period : DEFAULT_VIEW.period,
      layout: saved.layout === 'week' ? 'week' : 'month',
    };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

function saveView(view) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(view));
  } catch {
    // Remembering toggles is a convenience.
  }
}

export default function App() {
  const today = dayKey(Date.now());
  const [view, setView] = useState(loadView);
  const [anchor, setAnchor] = useState(today); // a day inside the month or week shown
  const [openDay, setOpenDay] = useState(null);
  const set = (patch) => setView((v) => ({ ...v, ...patch }));
  useEffect(() => saveView(view), [view]);

  // Stat cards follow the period buttons.
  const period = useMemo(() => periodDays(view.period, today), [view.period, today]);
  const stats = useTrades({ fromDay: period.from, toDay: period.to });

  // The calendar follows its own ‹ › navigation.
  const grid = useMemo(() => {
    if (view.layout === 'week') {
      const start = startOfWeek(anchor);
      return { weeks: [Array.from({ length: 7 }, (_, i) => addDays(start, i))], month: monthOf(anchor) };
    }
    return { weeks: monthGrid(monthOf(anchor)), month: monthOf(anchor) };
  }, [view.layout, anchor]);
  const calendar = useTrades({ fromDay: grid.weeks[0][0], toDay: addDays(grid.weeks.at(-1)[6], 1) });
  const calendarDays = useMemo(() => groupByDay(calendar.trades), [calendar.trades]);

  const choosePeriod = (id) => {
    set({ period: id });
    // This/Last Month also move the calendar to that month.
    if (id === 'thisMonth' || id === 'lastMonth') setAnchor(periodDays(id, today).from);
  };

  const step = (n) => setAnchor((a) => (view.layout === 'week' ? addDays(a, 7 * n) : firstOfMonth(addMonths(monthOf(a), n))));

  const error = stats.error ?? calendar.error;
  const loading = stats.loading || calendar.loading;
  const updatedAt = calendar.updatedAt ?? stats.updatedAt;

  return (
    <div className="flex min-h-screen flex-col gap-4 p-5">
      <header className="flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" variant="outline" value={view.period} onValueChange={(v) => v && choosePeriod(v)} aria-label="Period">
          {PERIODS.map((p) => (
            <ToggleGroupItem key={p.id} value={p.id} className="px-3">
              {p.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="ml-auto flex items-center gap-3">
          <ToggleGroup type="single" variant="outline" value={view.unit} onValueChange={(v) => v && set({ unit: v })} aria-label="Units">
            <ToggleGroupItem value="R" className="w-10">R</ToggleGroupItem>
            <ToggleGroupItem value="$" className="w-10">$</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup type="single" variant="outline" value={view.fees} onValueChange={(v) => v && set({ fees: v })} aria-label="Fees">
            <ToggleGroupItem value="gross" className="px-3" title="Fees ignored">Gross</ToggleGroupItem>
            <ToggleGroupItem value="net" className="px-3" title="Fees taken off">Net</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              stats.refresh();
              calendar.refresh();
            }}
            disabled={loading}
            aria-label="Refresh from Notion"
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            <span className="text-muted-foreground text-xs">
              {updatedAt ? `updated ${updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'loading…'}
            </span>
          </Button>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-loss/40 bg-loss/10 px-4 py-2 text-sm">
          <span>Notion unreachable: {error}</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => (stats.refresh(), calendar.refresh())}>
            Retry
          </Button>
        </div>
      )}

      <StatCards trades={stats.trades} view={view} loading={stats.loading && !stats.updatedAt} />

      <CalendarCard
        layout={view.layout}
        onLayout={(layout) => set({ layout })}
        weeks={grid.weeks}
        month={grid.month}
        today={today}
        days={calendarDays}
        view={view}
        onStep={step}
        onToday={() => setAnchor(today)}
        onOpenDay={setOpenDay}
      />

      <DayPanel day={openDay} trades={openDay ? calendarDays.get(openDay) ?? [] : []} view={view} onClose={() => setOpenDay(null)} />
    </div>
  );
}
