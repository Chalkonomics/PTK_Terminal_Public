// Tailwind classes for a result's tone ('profit' | 'loss' | 'scratch'), written out
// in full so Tailwind's scanner sees them.

export function toneText(tone) {
  return { profit: 'text-profit', loss: 'text-loss', scratch: 'text-scratch' }[tone] ?? '';
}

export function toneCell(tone) {
  return {
    profit: 'border-profit/70 bg-profit/10',
    loss: 'border-loss/70 bg-loss/10',
    scratch: 'border-scratch/50 bg-muted/40',
  }[tone] ?? '';
}
