import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadUiPrefs, saveConfigPatch, saveUiPrefs, switchBlockers } from '../src/main/session.js';

const ROOT = 'C:/ptk';
const P = (f) => path.join(ROOT, f);
const ADDRESS = '0x' + 'a'.repeat(40);
const FLAT = { position: null, orders: [] };

// ---- switch blockers ----

test('flat, idle, nothing tracked: switching allowed', () => {
  assert.deepEqual(switchBlockers({ account: FLAT, accountless: false, journal: { open: null }, busy: false }), []);
});

test('every in-flight condition blocks, each with its own reason', () => {
  const reasons = switchBlockers({
    account: { position: { size: 0.01 }, orders: [{ oid: 1 }, { oid: 2 }] },
    accountless: false,
    journal: { open: { tradeId: '0x1' } },
    busy: true,
  });
  assert.deepEqual(reasons, [
    'a press or panic is running',
    'a BTC position is open',
    '2 BTC order(s) resting',
    'the journal is still tracking a trade',
  ]);
});

test('unknown account state blocks, except in accountless dry run', () => {
  assert.deepEqual(switchBlockers({ account: null, accountless: false, journal: null, busy: false }), ['account state not loaded yet']);
  assert.deepEqual(switchBlockers({ account: null, accountless: true, journal: null, busy: false }), []);
});

// ---- config writer ----

function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const ops = [];
  return {
    files,
    ops,
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, d) => {
      ops.push(['write', p]);
      files.set(p, String(d));
    },
    renameSync: (a, b) => {
      ops.push(['rename', a, b]);
      files.set(b, files.get(a));
      files.delete(a);
    },
  };
}

const userConfig = { mode: 'testnet', accountAddress: ADDRESS, equitySource: 'fixed', equityFixed: 900, hotkeyLong: 'Ctrl+Up', hotkeyShort: 'Ctrl+Down', hotkeyPanic: 'Ctrl+0' };

test('patch is merged, other keys preserved, written via temp file + rename', () => {
  const fs = memFs({ [P('config.json')]: JSON.stringify(userConfig) });
  saveConfigPatch(ROOT, { mode: 'live' }, fs);
  assert.deepEqual(JSON.parse(fs.files.get(P('config.json'))), { ...userConfig, mode: 'live' });
  assert.deepEqual(fs.ops, [['write', P('config.json.tmp')], ['rename', P('config.json.tmp'), P('config.json')]]);
  assert.ok(!fs.files.has(P('config.json.tmp')));
});

test('an invalid result is refused and the file is untouched', () => {
  const original = JSON.stringify(userConfig);
  const fs = memFs({ [P('config.json')]: original });
  assert.throws(() => saveConfigPatch(ROOT, { mode: 'yolo' }, fs), /refusing to save config.json: mode must be one of/);
  assert.equal(fs.files.get(P('config.json')), original);
  assert.deepEqual(fs.ops, []);
});

test('live without an account address is refused', () => {
  const fs = memFs({ [P('config.json')]: JSON.stringify({ ...userConfig, accountAddress: '' }) });
  assert.throws(() => saveConfigPatch(ROOT, { mode: 'live' }, fs), /accountAddress/);
});

// ---- UI prefs ----

test('UI prefs: defaults when missing or corrupt, round-trip when saved', () => {
  assert.deepEqual(loadUiPrefs(ROOT, memFs()), { alwaysOnTop: true, compact: false });
  assert.deepEqual(loadUiPrefs(ROOT, memFs({ [P('ui-state.json')]: '{not json' })), { alwaysOnTop: true, compact: false });
  const fs = memFs();
  saveUiPrefs(ROOT, { alwaysOnTop: false, compact: true }, fs);
  assert.deepEqual(loadUiPrefs(ROOT, fs), { alwaysOnTop: false, compact: true });
  assert.deepEqual(loadUiPrefs(ROOT, memFs({ [P('ui-state.json')]: '{"compact":"yes"}' })), { alwaysOnTop: true, compact: false });
});
