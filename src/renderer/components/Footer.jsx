import { useState } from 'react';
import { ago } from '../format.js';

const ACTION_NAMES = { long: 'Long', short: 'Short', panic: 'Panic' };
const CHECK_ICON = { pass: '✓', fail: '✗', skip: '–', notRun: '·' };

export function SetupPicker({ labels, selected }) {
  return (
    <section>
      <h2>Setup</h2>
      <div className="segmented no-drag" role="radiogroup" aria-label="Setup label">
        {labels.map((label) => (
          <button
            key={label}
            role="radio"
            aria-checked={label === selected}
            className={label === selected ? 'active' : ''}
            onClick={() => window.ptk.command('setSetupLabel', { label })}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function LastAction({ action }) {
  return (
    <section>
      <h2>Last action</h2>
      {action ? (
        <p className={`last last-${action.kind}`}>
          {action.text} <span className="muted small">{ago(action.ageMs)}</span>
        </p>
      ) : (
        <p className="muted small">None this session</p>
      )}
    </section>
  );
}

export function Hotkeys({ hotkeys }) {
  return (
    <div className="hotkeys">
      {hotkeys.map((h) => (
        <span
          key={h.action}
          className={`hotkey ${h.registered === false ? 'bad' : h.registered ? '' : 'muted'}`}
          title={h.registered === false ? 'Another app owns this shortcut; it will not work' : h.registered === null ? 'Not registered yet' : 'Registered'}
        >
          {ACTION_NAMES[h.action]} <kbd>{h.accelerator}</kbd>
          {h.registered === false && ' ✗'}
        </span>
      ))}
    </div>
  );
}

export function JournalStatus({ journal }) {
  if (!journal || (!journal.open && !journal.pending && !journal.error)) return null;
  const parts = [
    journal.open && `tracking ${journal.open.direction} trade`,
    journal.pending > 0 && `${journal.pending} row(s) waiting to be written`,
    journal.error,
  ].filter(Boolean);
  return <p className={`small journal ${journal.error ? 'warn' : 'muted'}`}>Journal: {parts.join(' · ')}</p>;
}

export function NotionStatus({ notion }) {
  if (!notion || (!notion.pending && !notion.error)) return null;
  const parts = [notion.pending > 0 && `${notion.pending} update(s) waiting`, notion.error].filter(Boolean);
  return <p className={`small journal ${notion.error ? 'warn' : 'muted'}`}>Notion: {parts.join(' · ')}</p>;
}

export function HotkeyAlert({ hotkeys }) {
  const dead = hotkeys.filter((h) => h.registered === false);
  if (!dead.length) return null;
  return (
    <div className="alert" role="alert">
      <strong>Hotkey not working:</strong> {dead.map((h) => `${ACTION_NAMES[h.action]} (${h.accelerator})`).join(', ')} is
      claimed by another app. Close overlays (Discord, Steam, GeForce Experience) or change it in config.json, then restart.
    </div>
  );
}

export function Checks({ checks }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button className="link no-drag" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} Checks
      </button>
      {open && (
        <ol className="checks">
          {checks.map((c) => (
            <li key={c.id} className={`check-${c.status}`} title={c.detail ?? ''}>
              <span className="check-icon">{CHECK_ICON[c.status]}</span> {c.label}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
