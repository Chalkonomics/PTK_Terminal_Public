import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { dayOfMonth, formatTime, formatValue, monthLabel, shortDay, shownValue, summarize, WEEKDAYS } from '../lib/calendar.js';
import { toneCell, toneText } from './tone.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function weekSummary(week, days, view) {
  return summarize(week.flatMap((key) => days.get(key) ?? []), view);
}

/** One day in the month grid: total and trade count, bordered by result. */
function DayCell({ dayKey: key, trades, view, outside, isToday, onOpen }) {
  const s = summarize(trades, view);
  const has = s.count > 0;
  return (
    <button
      type="button"
      disabled={!trades.length}
      onClick={() => onOpen(key)}
      className={cn(
        'relative flex h-24 flex-col items-center justify-center rounded-lg border text-center transition-colors',
        has ? cn(toneCell(s.tone), 'hover:brightness-125 cursor-pointer') : 'border-border/60',
        outside && 'opacity-40',
        isToday && !has && 'border-ring',
      )}
      aria-label={`${shortDay(key)}: ${has ? `${formatValue(s.total, view.unit)}, ${plural(s.count, 'trade')}` : 'no trades'}`}
    >
      <span className={cn('absolute top-1.5 right-2 text-xs', isToday ? 'text-foreground font-semibold' : 'text-muted-foreground')}>{dayOfMonth(key)}</span>
      {has && (
        <>
          <span className={cn('text-lg font-semibold', toneText(s.tone))}>{formatValue(s.total, view.unit)}</span>
          <span className="text-muted-foreground text-xs">{plural(s.count, 'trade')}</span>
        </>
      )}
      {!has && trades.length > 0 && <span className="text-muted-foreground text-xs">{plural(trades.length, 'trade')}, no data</span>}
    </button>
  );
}

function WeekTotal({ index, summary, view }) {
  const has = summary.count > 0;
  return (
    <div className={cn('flex h-24 flex-col justify-center rounded-lg border px-3', has ? toneCell(summary.tone) : 'border-border/60')}>
      <span className="text-muted-foreground text-xs">Week {index + 1}</span>
      <span className={cn('text-base font-semibold', has ? toneText(summary.tone) : 'text-muted-foreground')}>{has ? formatValue(summary.total, view.unit) : '—'}</span>
      <span className="text-muted-foreground text-xs">{has ? plural(summary.count, 'trade') : 'no trades'}</span>
    </div>
  );
}

function MonthGrid({ weeks, month, today, days, view, onOpenDay }) {
  const inMonth = (key) => Number(key.slice(5, 7)) === month.month;
  return (
    <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_minmax(7rem,0.9fr)] gap-2">
      {WEEKDAYS.map((d) => (
        <div key={d} className="text-muted-foreground pb-1 text-center text-xs font-medium">{d}</div>
      ))}
      <div className="text-muted-foreground pb-1 text-center text-xs font-medium">Week</div>
      {weeks.map((week, i) => [
        ...week.map((key) => (
          <DayCell key={key} dayKey={key} trades={days.get(key) ?? []} view={view} outside={!inMonth(key)} isToday={key === today} onOpen={onOpenDay} />
        )),
        <WeekTotal key={`w${i}`} index={i} summary={weekSummary(week, days, view)} view={view} />,
      ])}
    </div>
  );
}

function WeekColumns({ week, today, days, view, onOpenDay }) {
  return (
    <div className="grid grid-cols-7 gap-2">
      {week.map((key, i) => {
        const trades = days.get(key) ?? [];
        const s = summarize(trades, view);
        return (
          <button
            type="button"
            key={key}
            disabled={!trades.length}
            onClick={() => onOpenDay(key)}
            className={cn('flex min-h-64 flex-col rounded-lg border p-2 text-left', s.count ? cn(toneCell(s.tone), 'hover:brightness-125') : 'border-border/60', key === today && !s.count && 'border-ring')}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground text-xs">{WEEKDAYS[i]}</span>
              <span className="text-muted-foreground text-xs">{shortDay(key)}</span>
            </div>
            {s.count > 0 && <div className={cn('mt-1 text-lg font-semibold', toneText(s.tone))}>{formatValue(s.total, view.unit)}</div>}
            <ul className="mt-2 flex flex-col gap-1 text-xs">
              {trades.map((t) => {
                const v = shownValue(t, view);
                return (
                  <li key={t.id} className="flex justify-between gap-1">
                    <span className="text-muted-foreground">{formatTime(t.date)} {t.direction === 'SHORT' ? 'S' : 'L'}</span>
                    <span className={Number.isFinite(v) ? toneText(v > 0 ? 'profit' : v < 0 ? 'loss' : 'scratch') : 'text-muted-foreground'}>{formatValue(v, view.unit)}</span>
                  </li>
                );
              })}
            </ul>
          </button>
        );
      })}
    </div>
  );
}

export default function CalendarCard({ layout, onLayout, weeks, month, today, days, view, onStep, onToday, onOpenDay }) {
  const title = layout === 'week' ? `${shortDay(weeks[0][0])} – ${shortDay(weeks[0][6])}` : monthLabel(month);
  const unit = layout === 'week' ? 'week' : 'month';
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4 px-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => onStep(-1)} aria-label={`Previous ${unit}`}><ChevronLeft /></Button>
          <h2 className="min-w-48 text-center text-xl font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" onClick={() => onStep(1)} aria-label={`Next ${unit}`}><ChevronRight /></Button>
          <Button variant="outline" size="sm" onClick={onToday}>Today</Button>
          <Tabs value={layout} onValueChange={onLayout} className="ml-auto">
            <TabsList>
              <TabsTrigger value="month">Month</TabsTrigger>
              <TabsTrigger value="week">Week</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {layout === 'week'
          ? <WeekColumns week={weeks[0]} today={today} days={days} view={view} onOpenDay={onOpenDay} />
          : <MonthGrid weeks={weeks} month={month} today={today} days={days} view={view} onOpenDay={onOpenDay} />}
      </CardContent>
    </Card>
  );
}
