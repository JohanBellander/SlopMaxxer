import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SLOPMAXXER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-collect-'));
const { collect } = await import('../src/collect.mjs');

const reading = (provider, used) => async () => ({
  provider, dir: `/fake/${provider}`, email: `${provider}@example.test`, accountKey: provider, plan: 'Pro', planSlug: 'pro',
  windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: used, windowSeconds: 7 * 86400, resetsAt: Date.now() + 86400_000 }],
});

test('a slow provider does not hold up the others: early answer first, complete one after', async () => {
  const installs = [{ provider: 'claude', dir: '/fake/claude' }, { provider: 'muse', dir: '/fake/muse' }];
  let museUsed = 10;
  let release;
  const slowMuse = async () => { await new Promise((r) => (release = r)); return reading('muse', museUsed)(); };
  const savedCount = () => fs.readFileSync(path.join(process.env.SLOPMAXXER_HOME, 'history.jsonl'), 'utf8').trim().split('\n').length;

  // First poll: no earlier Muse reading to show, so it waits for every provider.
  const first = collect({ waitMs: 50, installs, fetchers: { claude: reading('claude', 20), muse: slowMuse } });
  setTimeout(() => release(), 100);
  assert.deepEqual((await first).pending, []);
  assert.equal(savedCount(), 2);

  // Second poll: Claude answers, Muse is slow, so the answer comes early with Muse's last reading.
  museUsed = 40;
  let late;
  const early = await collect({ waitMs: 50, installs, onLate: (p) => (late = p), fetchers: { claude: reading('claude', 30), muse: slowMuse } });
  assert.deepEqual(early.pending, ['muse']);
  const used = (snap, p) => snap.accounts.find((a) => a.provider === p).windows[0].usedPercent;
  assert.equal(used(early, 'claude'), 30);
  assert.equal(used(early, 'muse'), 10);
  assert.equal(savedCount(), 3, 'only the new Claude reading is stored, not the carried Muse one');

  release();
  const complete = await late;
  assert.deepEqual(complete.pending, []);
  assert.equal(used(complete, 'claude'), 30);
  assert.equal(used(complete, 'muse'), 40);
  assert.equal(savedCount(), 4, 'the late Muse reading is stored once; Claude is not stored twice');
});
