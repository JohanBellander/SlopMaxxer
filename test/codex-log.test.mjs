import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newestLoggedLimits } from '../src/providers/codex.mjs';

const rl = (ts, used) => JSON.stringify({ timestamp: ts, payload: { rate_limits: { primary: { used_percent: used, window_minutes: 10080 } } } });

test('session log fallback: newest rate_limits of the newest file, found far before its end', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-'));
  const day = (d) => { const p = path.join(tmp, 'sessions', '2026', '10', d); fs.mkdirSync(p, { recursive: true }); return p; };
  fs.writeFileSync(path.join(day('29'), 'older.jsonl'), rl('2026-10-29T10:00:00Z', 99) + '\n');
  const filler = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'other', i, pad: 'x'.repeat(1000) }));
  fs.writeFileSync(path.join(day('30'), 'newest.jsonl'), [
    rl('2026-10-30T08:00:00Z', 20),
    rl('2026-10-30T09:00:00Z', 25),
    ...filler(300), // ~300 KB of short lines: more than one 256 KB block
    JSON.stringify({ type: 'other', pad: 'y'.repeat(600 * 1024) }), // one line spanning several blocks
    ...filler(5),
  ].join('\n') + '\n');
  const got = newestLoggedLimits(tmp);
  assert.equal(got.rl.primary.used_percent, 25);
  assert.equal(got.at, Date.parse('2026-10-30T09:00:00Z'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('session log fallback: a rate_limits line at the very start of a small file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-'));
  const p = path.join(tmp, 'sessions', '2026', '10', '30');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'a.jsonl'), rl('2026-10-30T08:00:00Z', 7)); // no trailing newline
  assert.equal(newestLoggedLimits(tmp).rl.primary.used_percent, 7);
  assert.equal(newestLoggedLimits(path.join(tmp, 'none')), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});
