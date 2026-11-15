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
const T = Date.now();
const sample = (used, id = 'a') => ({ t: T - 10 + used, id, kind: 'weekly', used });
const line = (s) => JSON.stringify(s) + '\n';
const saveScript = (...batches) => `
  import fs from 'node:fs';
  import { saveSamples } from ${JSON.stringify(new URL('../src/collect.mjs', import.meta.url).href)};
  ${batches.map((b) => (typeof b === 'string' ? b : `saveSamples(${JSON.stringify(b)});`)).join('\n')}`;
const childArgs = (home, script) => [process.execPath, ['--input-type=module', '-e', script],
  { env: { ...process.env, SLOPMAXXER_HOME: home, SLOPMAXXER_LOG: 'off' }, encoding: 'utf8' }];
const used = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).used);

function withHome(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-history-'));
    try { await fn(home, path.join(home, 'history.jsonl')); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
}

test('saving history keeps samples another process wrote and leaves no temp file', withHome((home, file) => {
  fs.writeFileSync(file, line(sample(1)));
  // The server loads the file on its first save, then a `status` run appends a sample it never saw.
  const script = saveScript([sample(2)], `fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line(sample(3, 'b')))});`, [sample(4)]);
  const r = spawnSync(...childArgs(home, script));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(used(file), [1, 2, 3, 4]);
  assert.deepEqual(fs.readdirSync(home), ['history.jsonl']);
}));

test('a save waits for another process holding the history lock, then keeps its samples', withHome(async (home, file) => {
  fs.writeFileSync(file, line(sample(1)));
  const lock = file + '.lock';
  fs.writeFileSync(lock, '');
  const child = spawn(...childArgs(home, saveScript([sample(2)])));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(used(file), [1], 'wrote while another process held the lock');
  // The lock holder commits its own sample, then releases.
  fs.appendFileSync(file, line(sample(3, 'b')));
  fs.unlinkSync(lock);
  assert.equal(await exited, 0);
  assert.deepEqual(used(file), [1, 2, 3]);
  assert.deepEqual(fs.readdirSync(home), ['history.jsonl']);
}));

test('a save skips rather than writing without the lock, and takes over an abandoned one', withHome((home, file) => {
  fs.writeFileSync(file, line(sample(1)));
  const lock = file + '.lock';
  fs.writeFileSync(lock, '');
  assert.equal(spawnSync(...childArgs(home, saveScript([sample(2)]))).status, 0);
  assert.deepEqual(used(file), [1]);
  assert.deepEqual(fs.readdirSync(home).sort(), ['history.jsonl', 'history.jsonl.lock']);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(spawnSync(...childArgs(home, saveScript([sample(2)]))).status, 0);
  assert.deepEqual(used(file), [1, 2]);
  assert.deepEqual(fs.readdirSync(home), ['history.jsonl']);
}));
