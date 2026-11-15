import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SLOPMAXXER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-collect-'));
const { collect, fromLastSamples } = await import('../src/collect.mjs');

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

const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
const codexReading = (dir, used) => ({
  provider: 'codex', dir, email: 'same@example.test', accountKey: 'same-login', plan: 'Pro', planSlug: 'pro',
  windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: used, windowSeconds: 7 * 86400, resetsAt: Date.now() + 86400_000 }],
});

test('the same login in two folders shows this poll\'s reading, not one carried from before', async () => {
  const installs = [{ provider: 'codex', dir: '/fake/codex-a' }, { provider: 'codex', dir: '/fake/codex-b' }];
  await collect({ installs, fetchers: { codex: async (i) => codexReading(i.dir, 10) } });
  const slowA = gate();
  let late;
  const early = await collect({ waitMs: 50, installs, onLate: (p) => (late = p), fetchers: {
    codex: async (i) => (i.dir.endsWith('-a') ? (await slowA.p, codexReading(i.dir, 10)) : codexReading(i.dir, 100)),
  } });
  assert.equal(early.accounts.length, 1);
  assert.equal(early.accounts[0].windows[0].usedPercent, 100, 'the fresh reading says it ran out');
  slowA.open();
  assert.equal((await late).accounts[0].windows[0].usedPercent, 100, 'a reading of the same moment must not hide it either');
});

test('the complete answer keeps the newer of two readings of one login, even if it came first', async () => {
  const installs = [{ provider: 'codex', dir: '/fake/codex-c' }, { provider: 'codex', dir: '/fake/codex-d' }];
  const at = (dir, used, observedAt) => ({ ...codexReading(dir, used), accountKey: 'same-login-2', observedAt });
  await collect({ installs, fetchers: { codex: async (i) => at(i.dir, 10, Date.now()) } });
  const slowD = gate();
  let late;
  await collect({ waitMs: 50, installs, onLate: (p) => (late = p), fetchers: {
    codex: async (i) => (i.dir.endsWith('-c') ? at(i.dir, 100, Date.now()) : (await slowD.p, at(i.dir, 10, Date.now() - 60_000))),
  } });
  slowD.open();
  const complete = await late;
  assert.equal(complete.accounts[0].windows[0].usedPercent, 100, 'the older late reading must not hide that it ran out');
  assert.equal(complete.nextUp, null);
});

test('two polls waiting on the same slow provider store its reading once', async () => {
  const installs = [{ provider: 'muse', dir: '/fake/muse-overlap' }];
  const lines = () => fs.readFileSync(path.join(process.env.SLOPMAXXER_HOME, 'history.jsonl'), 'utf8').trim().split('\n').length;
  const r = (used) => ({ ...codexReading('/fake/muse-overlap', used), provider: 'muse', accountKey: 'muse-overlap' });
  await collect({ installs, fetchers: { muse: async () => r(10) } });
  const before = lines();
  const slow = gate();
  const fetchers = { muse: async () => (await slow.p, r(40)) };
  const lates = [];
  await collect({ waitMs: 20, installs, fetchers, onLate: (p) => lates.push(p) });
  await collect({ waitMs: 20, installs, fetchers, onLate: (p) => lates.push(p) });
  slow.open();
  await Promise.all(lates);
  assert.equal(lates.length, 2);
  assert.equal(lines() - before, 1);
});

test('read at the same moment, a hard limit beats a higher percentage, and equal readings are stored once', async () => {
  const lines = () => fs.readFileSync(path.join(process.env.SLOPMAXXER_HOME, 'history.jsonl'), 'utf8').trim().split('\n').length;
  const pair = (key) => [{ provider: 'codex', dir: `/fake/${key}-a` }, { provider: 'codex', dir: `/fake/${key}-b` }];
  const r = (dir, key, used, limitReached = false) => ({ ...codexReading(dir, used), accountKey: key, limitReached });

  const tie = await collect({ installs: pair('limit'), fetchers: { codex: async (i) => (i.dir.endsWith('-a') ? r(i.dir, 'limit', 80, true) : r(i.dir, 'limit', 81)) } });
  assert.equal(tie.accounts[0].limitReached, true);
  assert.equal(tie.nextUp, null);

  const installs = pair('equal');
  await collect({ installs, fetchers: { codex: async (i) => r(i.dir, 'equal', 10) } });
  const before = lines();
  const slowA = gate();
  let late;
  await collect({ waitMs: 50, installs, onLate: (p) => (late = p), fetchers: { codex: async (i) => (i.dir.endsWith('-a') ? (await slowA.p, r(i.dir, 'equal', 20)) : r(i.dir, 'equal', 20)) } });
  slowA.open();
  await late;
  assert.equal(lines() - before, 1, 'one reading of the login per poll');
});

test('read at the same moment, an exhausted general allowance is not hidden behind a model cap', async () => {
  const installs = [{ provider: 'claude', dir: '/fake/claude-s-a' }, { provider: 'claude', dir: '/fake/claude-s-b' }];
  const t0 = Date.now();
  const r = (dir, all, opus) => ({
    provider: 'claude', dir, email: 'same@example.test', accountKey: 'scoped', plan: 'Max', planSlug: 'max', observedAt: t0,
    windows: [
      { kind: 'weekly', label: 'Weekly', scope: 'all', usedPercent: all, windowSeconds: 7 * 86400, resetsAt: t0 + 86400_000 },
      { kind: 'weekly_opus', label: 'Weekly · Opus', scope: 'opus', usedPercent: opus, windowSeconds: 7 * 86400, resetsAt: t0 + 86400_000 },
    ],
  });
  await collect({ installs, fetchers: { claude: async (i) => r(i.dir, 10, 10) } });
  const slowA = gate();
  let late;
  await collect({ waitMs: 50, installs, onLate: (p) => (late = p), fetchers: {
    claude: async (i) => (i.dir.endsWith('-a') ? (await slowA.p, r(i.dir, 100, 100)) : r(i.dir, 20, 100)),
  } });
  slowA.open();
  const complete = await late;
  assert.equal(complete.accounts[0].windows.find((w) => w.scope === 'all').usedPercent, 100);
  assert.equal(complete.nextUp, null);
});

const H = 3_600_000;
const now = Date.parse('2026-11-14T07:30:00Z');
const samples = [
  { t: now - 40 * H, id: 'm', kind: 'session', used: 40, resetsAt: now - 8 * H },
  { t: now - 40 * H, id: 'm', kind: 'weekly', used: 8, resetsAt: now + 40 * H, windowSeconds: 604800 },
];

test('a failed read older than 12h falls back to nothing, as before', () => {
  assert.equal(fromLastSamples({ id: 'm', provider: 'muse', error: 'muse usage failed: x' }, now, samples), null);
  // A window with no reset time can't be aged out by one, so Muse's no-usage case keeps the cutoff.
  const noReset = [{ t: now - 40 * H, id: 'm', kind: 'weekly', used: 42, resetsAt: null }];
  assert.equal(fromLastSamples({ id: 'm', provider: 'muse', error: 'x', noUsage: true }, now, noReset), null);
});

test('Muse sending no usage keeps the last weekly reading until its reset and starts a fresh window', () => {
  const a = fromLastSamples({ id: 'm', provider: 'muse', error: 'No usage reported yet — run Muse once to check', noUsage: true }, now, samples);
  const win = a.windows.find((w) => w.kind === 'session');
  const week = a.windows.find((w) => w.kind === 'weekly');
  assert.deepEqual([win.usedPercent, win.resetsAt, win.idle], [0, null, true]);
  assert.deepEqual([week.usedPercent, week.resetsAt, week.idle], [8, now + 40 * H, false]);
  // Never presented as a live reading.
  assert.equal(a.stale, true);
  assert.equal(a.error, undefined);
  assert.match(a.note, /showing the last reading from \w{3} \w{3} \d+ \d\d:\d\d/);
});
