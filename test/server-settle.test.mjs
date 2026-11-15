import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SLOPMAXXER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-settle-'));
const { startServer } = await import('../src/server.mjs');

const account = (used, observedAt) => ({
  id: 'm1', provider: 'muse', email: null, plan: 'Pro', planSlug: 'pro', observedAt, stale: false,
  windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: used, windowSeconds: 7 * 86400, resetsAt: Date.now() + 86400_000, observedAt }],
});

test('while a slow provider settles, refreshes join it and only the complete answer writes events', async (t) => {
  let polls = 0;
  let open;
  const poll = async ({ onLate }) => {
    polls++;
    const old = Date.now() - 30 * 60_000; // carried and past freshness: the early pass would read "refresh needed"
    onLate(new Promise((r) => (open = r)).then(() => ({ generatedAt: Date.now(), accounts: [account(10, Date.now())], nextUp: null, pending: [] })));
    return { generatedAt: Date.now(), accounts: [account(10, old)], nextUp: null, pending: ['muse'] };
  };
  const url = await new Promise((resolve, reject) => {
    const server = startServer({ port: 0, warm: false, poll, onReady: resolve, onError: reject });
    t.after(() => new Promise((r) => server.close(r)));
  });
  const events = () => { try { return fs.readFileSync(path.join(process.env.SLOPMAXXER_HOME, 'events.jsonl'), 'utf8'); } catch { return ''; } };

  const early = await (await fetch(`${url}/api/slop`)).json();
  assert.deepEqual(early.pending, ['muse']);
  assert.equal(events(), '', 'the early answer is not written to the event log');
  await fetch(`${url}/api/slop?refresh=1`);
  assert.equal(polls, 1, 'a forced refresh while settling does not start a second poll');

  const settledReq = fetch(`${url}/api/slop?settled=1`);
  open();
  const complete = await (await settledReq).json();
  assert.deepEqual(complete.pending, []);
  assert.doesNotMatch(events(), /refresh needed/);
});
