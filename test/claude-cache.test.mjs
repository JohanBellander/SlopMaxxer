import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedClaudeUsage } from '../src/claude-cache.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let time = Date.parse('2026-10-31T12:00:00Z');
  return { home, key: 'test-account', now: () => time, advance: (ms) => { time += ms; } };
}
const ok = () => new Response(JSON.stringify({ five_hour: { utilization: 12 } }));

test('shares successful readings, separates accounts, and expires after five minutes', async (t) => {
  const opts = setup(t);
  let calls = 0;
  const request = async () => { calls++; return ok(); };
  assert.equal((await cachedClaudeUsage({ ...opts, request })).cached, false);
  assert.equal((await cachedClaudeUsage({ ...opts, request })).cached, true);
  assert.equal(calls, 1);
  await cachedClaudeUsage({ ...opts, key: 'another', request });
  assert.equal(calls, 2);
  opts.advance(300_000);
  await cachedClaudeUsage({ ...opts, request });
  assert.equal(calls, 3);
});

test('concurrent callers do not issue duplicate requests', async (t) => {
  const opts = setup(t);
  let finish;
  const first = cachedClaudeUsage({ ...opts, request: () => new Promise((resolve) => { finish = resolve; }) });
  const second = await cachedClaudeUsage({ ...opts, request: () => { assert.fail('duplicate request'); } });
  assert.match(second.error, /in progress/);
  finish(ok());
  await first;
  assert.equal((await cachedClaudeUsage({ ...opts, request: () => assert.fail() })).usage.five_hour.utilization, 12);
});

test('429 backs off, honors Retry-After seconds and dates, and preserves the original reading', async (t) => {
  const opts = setup(t);
  const initial = await cachedClaudeUsage({ ...opts, request: async () => ok() });
  opts.advance(300_000);
  const limited = async (header) => cachedClaudeUsage({ ...opts, request: async () => new Response('', { status: 429, headers: { 'retry-after': header } }) });
  let result = await limited('0');
  assert.equal(result.retryAt - opts.now(), 300_000);
  assert.equal(result.fetchedAt, initial.fetchedAt);
  assert.equal(result.usage.five_hour.utilization, 12);
  await cachedClaudeUsage({ ...opts, request: () => assert.fail('cooldown bypassed') });
  opts.advance(300_000);
  result = await limited('0');
  assert.equal(result.retryAt - opts.now(), 600_000);
  opts.advance(600_000);
  result = await limited('7200');
  assert.equal(result.retryAt - opts.now(), 7_200_000);
  opts.advance(7_200_000);
  result = await limited(new Date(opts.now() + 9_000_000).toUTCString());
  assert.equal(result.retryAt - opts.now(), 9_000_000);
  opts.advance(9_000_000);
  result = await cachedClaudeUsage({ ...opts, request: async () => ok() });
  assert.equal(result.error, undefined);
  assert.equal(result.cached, false);
});

test('network failures cool down and old readings expire', async (t) => {
  const opts = setup(t);
  await cachedClaudeUsage({ ...opts, request: async () => ok() });
  opts.advance(13 * 3600_000);
  const result = await cachedClaudeUsage({ ...opts, request: async () => { throw new Error('network'); } });
  assert.equal(result.usage, null);
  assert.equal(result.retryAt - opts.now(), 300_000);
});
