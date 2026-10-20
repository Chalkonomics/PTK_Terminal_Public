import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardWatcher } from '../src/main/clipboard.js';

function setup(initial) {
  const env = { text: initial, time: 1_000_000, throwNext: false, reads: 0 };
  const watcher = createClipboardWatcher({
    readText: async () => {
      env.reads++;
      if (env.throwNext) {
        env.throwNext = false;
        throw new Error('clipboard locked');
      }
      return env.text;
    },
    pollMs: 250,
    now: () => env.time,
  });
  return { env, watcher };
}

test('content present at startup has unknown age', async () => {
  const { watcher } = setup('83,298');
  await watcher.tick();
  const s = watcher.snapshot();
  assert.equal(s.value, 83298);
  assert.equal(s.capturedAt, null);
  assert.equal(s.ageMs, Infinity);
});

test('a new copy is timestamped and ages', async () => {
  const { env, watcher } = setup('hello');
  await watcher.tick();
  env.text = '83,298';
  await watcher.tick();
  assert.equal(watcher.snapshot().capturedAt, 1_000_000);
  env.time += 30_000;
  await watcher.tick();
  assert.equal(watcher.snapshot().ageMs, 30_000);
});

test('unchanged text does not reset the timestamp', async () => {
  const { env, watcher } = setup('');
  await watcher.tick();
  env.text = '83,298';
  await watcher.tick();
  env.time += 5_000;
  await watcher.tick();
  assert.equal(watcher.snapshot().capturedAt, 1_000_000);
});

test('unparseable copies are captured with an error', async () => {
  const { env, watcher } = setup('');
  await watcher.tick();
  env.text = 'some url';
  await watcher.tick();
  const s = watcher.snapshot();
  assert.equal(s.value, null);
  assert.equal(s.raw, 'some url');
  assert.ok(s.error);
});

test('a failed read is skipped without losing state', async () => {
  const { env, watcher } = setup('');
  await watcher.tick();
  env.text = '83,298';
  await watcher.tick();
  env.throwNext = true;
  await assert.doesNotReject(() => watcher.tick());
  assert.equal(watcher.snapshot().value, 83298);
});

test('overlapping ticks do not stack reads', async () => {
  const { env, watcher } = setup('83,298');
  await Promise.all([watcher.tick(), watcher.tick(), watcher.tick()]);
  assert.equal(env.reads, 1);
});
