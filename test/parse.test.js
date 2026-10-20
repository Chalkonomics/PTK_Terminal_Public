import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStopPrice } from '../src/main/parse.js';

const ok = (raw, expected) => assert.deepEqual(parseStopPrice(raw), { value: expected, error: null }, `input ${JSON.stringify(raw)}`);
const rejected = (raw) => {
  const r = parseStopPrice(raw);
  assert.equal(r.value, null, `input ${JSON.stringify(raw)} should be rejected`);
  assert.ok(r.error);
};

test('parses the observed chart format', () => {
  ok('83,298', 83298);
  ok('  83,298\n', 83298);
});

test('comma is always a thousands separator, never a decimal (locale hazard)', () => {
  ok('83,298', 83298);
  assert.notEqual(parseStopPrice('83,298').value, 83.298);
  ok('1,234,567', 1234567);
});

test('accepts plain and decimal values', () => {
  ok('83298', 83298);
  ok('83298.5', 83298.5);
  ok('83 298', 83298);
});

test('rejects zero', () => {
  rejected('0');
  rejected('0.00');
  rejected(',');
});

test('rejects negatives (minus sign is not whitelisted)', () => {
  rejected('-83,298');
});

test('rejects non-price text', () => {
  rejected('https://app.hyperliquid.xyz/trade/BTC');
  rejected('BTC 83,298');
  rejected('$83,298');
  rejected('83,298e2');
  rejected('Infinity');
});

test('rejects malformed numbers', () => {
  rejected('83.298.5');
  rejected('.');
  rejected('');
  rejected('   ');
});

test('rejects overlong strings', () => {
  rejected('1'.repeat(25));
});

test('rejects non-strings', () => {
  rejected(undefined);
  rejected(null);
  rejected(83298);
});
