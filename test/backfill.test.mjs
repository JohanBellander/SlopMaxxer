import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyFromReadings, claudeEstimatedDaily, codexDiskSamples, claudeDiskUsage, weightedUnits } from '../src/backfill.mjs';

const H = 3_600_000;
const now = new Date(2026, 9, 31, 12, 0).getTime(); // local noon, Oct 31
const day = (offset, hour) => new Date(2026, 9, 31 + offset, hour).getTime(); // offset 0 = today

test('readings: gains per day, first reading is only a baseline', () => {
  const R1 = day(3, 0);
  const days = dailyFromReadings([
    { t: day(-2, 9), used: 30, resetsAt: R1 }, // baseline: we don't know when the 30% happened
    { t: day(-2, 15), used: 38, resetsAt: R1 },
    { t: day(-1, 10), used: 45, resetsAt: R1 },
    { t: day(0, 9), used: 50, resetsAt: R1 },
  ], now);
  assert.deepEqual(days, [0, 0, 0, 0, 8, 7, 5]);
});

test('readings: a new window (refill or banked reset) starts from 0; stragglers are ignored', () => {
  const R1 = day(0, 12);
  const R2 = day(6, 12);
  const days = dailyFromReadings([
    { t: day(-1, 8), used: 60, resetsAt: R1 },
    { t: day(-1, 20), used: 90, resetsAt: R1 },
    { t: day(0, 9), used: 5, resetsAt: R2 }, // reset happened: +5
    { t: day(0, 9) + 60_000, used: 91, resetsAt: R1 }, // an old session still reporting the previous window
    { t: day(0, 10), used: 12, resetsAt: R2 + 4000 }, // same window, reset reported a few seconds off
  ], now);
  assert.equal(days[5], 30);
  assert.equal(days[6], 12);
});

test('claude estimate: calibrated on the live weekly %, only before our own readings start', () => {
  const resetsAt = day(4, 12); // window started 3 days ago at noon
  const usage = [
    { t: day(-5, 10), units: 2 }, // previous window: shape only
    { t: day(-2, 13), units: 1 },
    { t: day(-1, 13), units: 1 },
    { t: day(0, 11), units: 2 }, // after exactFrom → covered by real readings
  ];
  const { days, factor } = claudeEstimatedDaily(usage, { resetsAt, usedPercent: 20 }, day(0, 10), now);
  assert.equal(factor, 5); // 20% over 4 units in this window
  assert.deepEqual(days, [0, 10, 0, 0, 5, 5, 0]);
});

test('weighted units follow model prices', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(weightedUnits('claude-opus-5-5', u), 5);
  assert.equal(weightedUnits('claude-sonnet-5-5', u), 3);
  assert.equal(weightedUnits('claude-haiku-5-5', { output_tokens: 1_000_000 }), 5);
  assert.equal(weightedUnits('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }), 0.5);
});

test('reads Codex session logs and Claude transcripts from disk, incrementally', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-'));
  const sess = path.join(tmp, 'codex', 'sessions', '2026', '10', '30');
  fs.mkdirSync(sess, { recursive: true });
  const rl = (t, used) => JSON.stringify({ timestamp: new Date(t).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(day(5, 7) / 1000) }, secondary: null } } });
  const f = path.join(sess, 'rollout.jsonl');
  fs.writeFileSync(f, [rl(day(-1, 9), 10), '{"timestamp":"x","type":"other"}', rl(day(-1, 12), 14)].join('\n') + '\n');
  assert.deepEqual(codexDiskSamples(path.join(tmp, 'codex'), now).map((s) => s.used), [10, 14]);
  fs.appendFileSync(f, rl(day(0, 9), 20) + '\n');
  assert.deepEqual(codexDiskSamples(path.join(tmp, 'codex'), now).map((s) => s.used), [10, 14, 20]);

  const proj = path.join(tmp, 'claude', 'projects', 'repo');
  fs.mkdirSync(proj, { recursive: true });
  const msg = (id, t) => JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
  // Claude Code writes one line per content block with the same usage: count it once.
  fs.writeFileSync(path.join(proj, 's.jsonl'), [msg('m1', day(0, 9)), msg('m1', day(0, 9)), msg('m2', day(0, 10))].join('\n') + '\n');
  const usage = claudeDiskUsage(path.join(tmp, 'claude'), now);
  assert.equal(usage.length, 2);
  assert.equal(usage[0].units, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});
