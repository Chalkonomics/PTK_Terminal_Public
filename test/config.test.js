import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS, agentKeyVar, resolveAgentKey, validateConfig } from '../src/main/config.js';

const ADDRESS = '0x' + 'a'.repeat(40);

test('example config is valid once an address is set', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(validateConfig({ ...example, accountAddress: ADDRESS }), []);
});

test('dry run with fixed equity needs no address', () => {
  assert.deepEqual(validateConfig({ ...DEFAULTS, equitySource: 'fixed' }), []);
});

test('live mode requires an address', () => {
  const errors = validateConfig({ ...DEFAULTS, mode: 'live', equitySource: 'fixed' });
  assert.ok(errors.some((e) => e.includes('accountAddress')));
});

test('rejects non-BTC symbols, bad modes and duplicate hotkeys', () => {
  const errors = validateConfig({ ...DEFAULTS, accountAddress: ADDRESS, symbol: 'ETH', mode: 'yolo', hotkeyShort: DEFAULTS.hotkeyLong });
  assert.ok(errors.some((e) => e.includes('symbol')));
  assert.ok(errors.some((e) => e.includes('mode')));
  assert.ok(errors.some((e) => e.includes('distinct')));
});

test('sound entries must be bare file names or null', () => {
  assert.deepEqual(validateConfig({ ...DEFAULTS, equitySource: 'fixed', sounds: { accepted: 'reload.mp3', refused: null, danger: 'alarm.wav' } }), []);
  const bad = validateConfig({ ...DEFAULTS, equitySource: 'fixed', sounds: { accepted: '../secret.mp3', refused: 'beep.exe', danger: null, extra: null } });
  assert.ok(bad.some((e) => e.includes('sounds.accepted')));
  assert.ok(bad.some((e) => e.includes('sounds.refused')));
  assert.ok(bad.some((e) => e.includes('unknown keys: extra')));
});

test('rejects absurd risk', () => {
  const errors = validateConfig({ ...DEFAULTS, accountAddress: ADDRESS, riskPct: 1 });
  assert.ok(errors.some((e) => e.includes('riskPct')));
});

test('each mode reads its own API wallet key from .env', () => {
  const keyT = '0x' + '1'.repeat(64);
  const keyM = '0x' + '2'.repeat(64);
  const env = { HL_AGENT_KEY_TESTNET: keyT, HL_AGENT_KEY_MAINNET: ` ${keyM} ` };
  assert.equal(resolveAgentKey(env, 'testnet'), keyT);
  assert.equal(resolveAgentKey(env, 'live'), keyM);
  assert.throws(() => agentKeyVar('dryRun'), /no API wallet key is used in dryRun/);
});

test('missing, malformed and legacy keys give clear errors without echoing the key', () => {
  assert.throws(() => resolveAgentKey({}, 'live'), /HL_AGENT_KEY_MAINNET missing .* mainnet API wallet/);
  assert.throws(() => resolveAgentKey({ HL_AGENT_PRIVATE_KEY: '0x' + '3'.repeat(64) }, 'testnet'), /rename it to HL_AGENT_KEY_TESTNET/);
  const address = '0x' + 'a'.repeat(40);
  assert.throws(() => resolveAgentKey({ HL_AGENT_KEY_TESTNET: address }, 'testnet'), (err) => /looks like a wallet address/.test(err.message) && !err.message.includes(address));
  const secret = '0x' + '4'.repeat(63);
  assert.throws(() => resolveAgentKey({ HL_AGENT_KEY_MAINNET: secret }, 'live'), (err) => !err.message.includes(secret));
});
