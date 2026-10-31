import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWindow, analyzeAccount, pickNext } from '../src/pace.mjs';

const H = 3_600_000;
const now = Date.parse('2026-10-31T12:00:00Z');
const weekly = (used, hoursLeft) => ({ kind: 'weekly', label: 'Weekly', usedPercent: used, windowSeconds: 7 * 86400, resetsAt: now + hoursLeft * H, idle: false });
const session = (used, hoursLeft, idle = false) => ({ kind: 'session', label: '5-hour', usedPercent: used, windowSeconds: 5 * 3600, resetsAt: idle ? null : now + hoursLeft * H, idle });

test('behind pace on weekly → PICK_UP', () => {
  // 3.5 days into the week (50% expected) but only 20% used.
  assert.equal(analyzeWindow(weekly(20, 84), now).verdict, 'PICK_UP');
});

test('on pace → ON_PACE', () => {
  assert.equal(analyzeWindow(weekly(48, 84), now).verdict, 'ON_PACE');
});

test('burning too fast → SLOW_DOWN', () => {
  // 80% used halfway through the week: at this rate you hit the cap long before reset.
  assert.equal(analyzeWindow(weekly(80, 84), now).verdict, 'SLOW_DOWN');
});

test('lots left with <24h to reset → LOSE_IT', () => {
  assert.equal(analyzeWindow(weekly(50, 10), now).verdict, 'LOSE_IT');
});

test('at the cap → COOKED', () => {
  assert.equal(analyzeWindow(weekly(100, 30), now).verdict, 'COOKED');
});

test('unstarted 5h window → IDLE', () => {
  assert.equal(analyzeWindow(session(0, 0, true), now).verdict, 'IDLE');
});

test('observed burn rate drives the projection', () => {
  const w = analyzeWindow(weekly(48, 84), now, 2); // 2%/h right now
  assert.ok(w.projectedPercent > 100);
});

test('session capped but weekly has room → WAIT', () => {
  const a = analyzeAccount({ provider: 'claude', windows: [session(100, 2), weekly(40, 84)] }, now);
  assert.equal(a.verdict, 'WAIT');
});

test('idle 5h window with weekly on pace → nudge to start it', () => {
  const a = analyzeAccount({ provider: 'claude', windows: [session(0, 0, true), weekly(50, 84)] }, now);
  assert.equal(a.verdict, 'IDLE');
});

test('pickNext prefers capacity expiring soonest and skips cooked accounts', () => {
  const soon = analyzeAccount({ id: 'soon', provider: 'codex', windows: [weekly(30, 20)] }, now);
  const later = analyzeAccount({ id: 'later', provider: 'claude', windows: [weekly(30, 150)] }, now);
  const cooked = analyzeAccount({ id: 'cooked', provider: 'claude', windows: [weekly(100, 5)] }, now);
  assert.equal(pickNext([later, cooked, soon]).id, 'soon');
  assert.equal(pickNext([cooked]), null);
});
