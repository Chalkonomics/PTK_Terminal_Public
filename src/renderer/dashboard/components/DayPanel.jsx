import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { classify, formatTime, formatValue, shortDay, shownValue, summarize } from '../lib/calendar.js';
import { toneText } from './tone.js';

const OUTCOME = { win: 'Win', loss: 'Loss', be: 'BE' };

/** The trades of one day, each linking to its Notion page. */
export default function DayPanel({ day, trades, view, onClose }) {
  const s = summarize(trades, view);
  return (
    <Sheet open={day !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[420px] sm:max-w-[420px]">
        {day && (
          <>
            <SheetHeader>
              <SheetTitle>{shortDay(day)}</SheetTitle>
              <SheetDescription>
                <span className={cn('font-semibold', toneText(s.tone))}>{formatValue(s.total, view.unit)}</span>
                {' · '}
                {s.count} trade{s.count === 1 ? '' : 's'} · {view.fees === 'net' ? 'after fees' : 'before fees'}
              </SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col gap-2 px-4">
              {trades.map((t) => {
                const v = shownValue(t, view);
                const c = classify(t, view.fees);
                return (
                  <li key={t.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                    <span className="text-muted-foreground w-12 text-sm">{formatTime(t.date)}</span>
                    <Badge variant="outline">{t.direction ?? '?'}</Badge>
                    <span className={cn('font-semibold', Number.isFinite(v) ? toneText(c === 'win' ? 'profit' : c === 'loss' ? 'loss' : 'scratch') : 'text-muted-foreground')}>
                      {formatValue(v, view.unit)}
                    </span>
                    <span className="text-muted-foreground text-xs">{c ? OUTCOME[c] : 'no data'}</span>
                    {t.url && (
                      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => window.dashboard.openInNotion(t.url)}>
                        Notion <ExternalLink />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
