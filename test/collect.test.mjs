import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('saving history keeps samples another process wrote and leaves no temp file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-history-'));
  try {
    const file = path.join(home, 'history.jsonl');
    const t = Date.now();
    fs.writeFileSync(file, JSON.stringify({ t: t - 3, id: 'a', kind: 'weekly', used: 1 }) + '\n');
    // The server loads the file on its first save, then a `status` run appends a sample it never saw.
    const script = `
      import fs from 'node:fs';
      import { saveSamples } from ${JSON.stringify(new URL('../src/collect.mjs', import.meta.url).href)};
      saveSamples([{ t: ${t - 2}, id: 'a', kind: 'weekly', used: 2 }]);
      fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({ t: ${t - 1}, id: 'b', kind: 'weekly', used: 3 }) + '\\n');
      saveSamples([{ t: ${t}, id: 'a', kind: 'weekly', used: 4 }]);`;
    const env = { ...process.env, SLOPMAXXER_HOME: home, SLOPMAXXER_LOG: 'off' };
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((s) => s.used), [1, 2, 3, 4]);
    assert.deepEqual(fs.readdirSync(home), ['history.jsonl']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
