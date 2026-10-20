import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createActivityLog, localDate, redact, RETENTION_DAYS } from '../src/main/activityLog.js';

const DIR = path.join('C:/ptk', 'logs');
const P = (name) => path.join(DIR, name);

function memFs({ failAppend = false, failMkdir = false } = {}) {
  const files = new Map();
  return {
    files,
    mkdirSync() {
      if (failMkdir) throw new Error('EACCES');
    },
    readdirSync: () => [...files.keys()].map((p) => path.basename(p)),
    unlinkSync: (p) => files.delete(p),
    appendFileSync(p, d) {
      if (failAppend) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      files.set(p, (files.get(p) ?? '') + d);
    },
  };
}

const NOON = new Date(2026, 9, 5, 12, 0, 0).getTime(); // 5 Oct 2026, local noon

test('lines go to a daily file with a timestamp, and to the console', () => {
  const fs = memFs();
  const echoed = [];
  const log = createActivityLog({ dir: DIR, now: () => NOON, fs, echo: (l) => echoed.push(l) });
  log.log('[order] sending {...}');
  log.log('[order] outcome: protected');
  const content = fs.files.get(P('ptk-2026-10-05.log'));
  assert.equal(content.split('\n').filter(Boolean).length, 2);
  assert.match(content, new RegExp(`^${new Date(NOON).toISOString()} \\[order\\] sending`));
  assert.deepEqual(echoed, ['[order] sending {...}', '[order] outcome: protected']);
  assert.equal(log.file, P('ptk-2026-10-05.log'));
});

test('files roll over at local midnight', () => {
  const fs = memFs();
  let t = new Date(2026, 9, 5, 23, 59, 59).getTime();
  const log = createActivityLog({ dir: DIR, now: () => t, fs, echo: () => {} });
  log.log('before midnight');
  t += 2000;
  log.log('after midnight');
  assert.ok(fs.files.has(P('ptk-2026-10-05.log')));
  assert.ok(fs.files.has(P('ptk-2026-10-06.log')));
});

test('anything shaped like a private key is redacted, on disk and on the console', () => {
  const key = '0x' + 'ab'.repeat(32);
  assert.equal(redact(`key=${key} end`), 'key=[redacted] end');
  assert.equal(redact('cloid 0x' + 'c'.repeat(32)), 'cloid 0x' + 'c'.repeat(32), '16-byte cloids are kept');
  assert.equal(redact('addr 0x' + 'd'.repeat(40)), 'addr 0x' + 'd'.repeat(40), 'addresses are kept');
  const fs = memFs();
  const echoed = [];
  createActivityLog({ dir: DIR, now: () => NOON, fs, echo: (l) => echoed.push(l) }).log(`oops ${key}`);
  assert.ok(!fs.files.get(P('ptk-2026-10-05.log')).includes(key));
  assert.ok(!echoed[0].includes(key));
});

test(`files older than ${RETENTION_DAYS} days are pruned at startup; others are untouched`, () => {
  const fs = memFs();
  const old = localDate(NOON - (RETENTION_DAYS + 1) * 86_400_000);
  const recent = localDate(NOON - 3 * 86_400_000);
  fs.files.set(P(`ptk-${old}.log`), 'x');
  fs.files.set(P(`ptk-${recent}.log`), 'x');
  fs.files.set(P('notes.txt'), 'keep me');
  createActivityLog({ dir: DIR, now: () => NOON, fs, echo: () => {} });
  assert.ok(!fs.files.has(P(`ptk-${old}.log`)));
  assert.ok(fs.files.has(P(`ptk-${recent}.log`)));
  assert.ok(fs.files.has(P('notes.txt')));
});

test('write failures never throw; the console still gets the line', () => {
  const echoed = [];
  const log = createActivityLog({ dir: DIR, now: () => NOON, fs: memFs({ failAppend: true }), echo: (l) => echoed.push(l) });
  assert.doesNotThrow(() => log.log('[panic] flattening'));
  assert.deepEqual(echoed, ['[panic] flattening']);
});

test('an unusable folder falls back to console-only', () => {
  const echoed = [];
  const fs = memFs({ failMkdir: true });
  const log = createActivityLog({ dir: DIR, now: () => NOON, fs, echo: (l) => echoed.push(l) });
  log.log('hello');
  assert.match(echoed[0], /logging to console only/);
  assert.equal(echoed[1], 'hello');
  assert.equal(fs.files.size, 0);
});
