import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fromLastSamples } from '../src/collect.mjs';

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

// History saves run in child processes with their own SLOPMAXXER_HOME, never the real one.
// Inside a child, load('x') imports a separate copy of collect.mjs, i.e. a separate "process" state.
const DAY = 86_400_000;
const T = Date.now();
const day = (t) => new Date(t).toISOString().slice(0, 10);
const sample = (used, id = 'a', t = T - 1000 + used) => ({ t, id, kind: 'weekly', used });
const line = (s) => JSON.stringify(s) + '\n';
const script = (body) => `
  const load = (tag) => import(${JSON.stringify(new URL('../src/collect.mjs', import.meta.url).href)} + '?' + tag);
  ${body}`;
const childArgs = (home, body, env = {}) => [process.execPath, ['--input-type=module', '-e', script(body)],
  { env: { ...process.env, SLOPMAXXER_HOME: home, SLOPMAXXER_LOG: 'off', ...env }, encoding: 'utf8' }];
function run(home, body, env) {
  const r = spawnSync(...childArgs(home, body, env));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const loaded = (home) => JSON.parse(run(home, `console.log(JSON.stringify((await load('read')).loadHistory()))`));
const save = (list, tag = 'w') => `(await load(${JSON.stringify(tag)})).saveSamples(${JSON.stringify(list)});`;

function withHome(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-history-'));
    try { await fn(home, path.join(home, 'history')); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
}

test('concurrent saves from two processes both survive, appended to day files only', withHome(async (home) => {
  const saver = (id) => new Promise((resolve) => {
    const body = `const m = await load('s'); for (let i = 0; i < 200; i++) m.saveSamples([{ t: ${T - 1000} + i, id: '${id}', kind: 'weekly', used: i }]);`;
    spawn(...childArgs(home, body)).on('exit', resolve);
  });
  assert.deepEqual(await Promise.all([saver('a'), saver('b')]), [0, 0]);
  const h = loaded(home);
  assert.equal(h.filter((s) => s.id === 'a').length, 200);
  assert.equal(h.filter((s) => s.id === 'b').length, 200);
  assert.deepEqual(fs.readdirSync(home), ['history']);
}));

test('three savers with stale views interleave without losing a sample', withHome((home) => {
  const out = run(home, `
    const [a, b, c] = [await load('a'), await load('b'), await load('c')];
    for (const m of [a, b, c]) m.loadHistory();
    a.saveSamples([${JSON.stringify(sample(1, 'a'))}]);
    b.saveSamples([${JSON.stringify(sample(2, 'b'))}]);
    c.saveSamples([${JSON.stringify(sample(3, 'c'))}]);
    b.saveSamples([${JSON.stringify(sample(4, 'b'))}, ${JSON.stringify(sample(2, 'b'))}]);
    a.saveSamples([${JSON.stringify(sample(5, 'a'))}]);
    console.log(JSON.stringify((await load('d')).loadHistory().map((s) => s.used)));`);
  assert.deepEqual(JSON.parse(out), [1, 2, 3, 4, 5]);
}));

test('pruning drops only day files that ended before the 35-day window', withHome((home, dir) => {
  fs.mkdirSync(dir);
  const old = sample(1, 'a', T - 36 * DAY), kept = sample(2, 'a', T - 34 * DAY);
  fs.writeFileSync(path.join(dir, `${day(old.t)}.jsonl`), line(old));
  fs.writeFileSync(path.join(dir, `${day(kept.t)}.jsonl`), line(kept));
  run(home, save([sample(3)]));
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${day(kept.t)}.jsonl`, `${day(T - 997)}.jsonl`].sort());
  assert.deepEqual(loaded(home).map((s) => s.used), [2, 3]);
}));

test('the legacy history.jsonl is read, deduped and kept until all of it is past the window', withHome((home, dir) => {
  const legacy = path.join(home, 'history.jsonl');
  const inWindow = sample(1), aged = sample(9, 'a', T - 40 * DAY);
  fs.writeFileSync(legacy, line(aged) + line(inWindow));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${day(inWindow.t)}.jsonl`), line(inWindow) + line(sample(2)));
  assert.deepEqual(loaded(home).map((s) => s.used), [1, 2]);
  run(home, save([sample(3)]));
  assert.equal(fs.readFileSync(legacy, 'utf8'), line(aged) + line(inWindow), 'never rewritten or removed while in the window');
  fs.writeFileSync(legacy, line(aged));
  run(home, save([sample(4)]));
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(loaded(home).map((s) => s.used), [1, 2, 3, 4]);
}));

test("a sample's day file is its UTC day, whatever the local time zone", withHome((home, dir) => {
  const y = new Date(T - DAY);
  const late = sample(1, 'a', Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 23, 30));
  run(home, save([late]), { TZ: 'Pacific/Kiritimati' }); // UTC+14: already the next local day
  assert.deepEqual(fs.readdirSync(dir), [`${day(late.t)}.jsonl`]);
}));
