import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, meterGlyphs, brailleSpark, timelineGlyphs } from '../public/slop.js';
import { MOCK, shiftedMock } from '../src/mock.mjs';
import { toSlopAccount, dailyFromSamples, diffEvents } from '../src/snapshot.mjs';

const H = 3_600_000;

test('reference mock reproduces the handoff numbers', () => {
  const vm = derive(MOCK);
  assert.equal(vm.score, 85);
  assert.equal(vm.rank.name, 'pace keeper');
  assert.equal(vm.next.id, 'codex-personal');
  assert.deepEqual(vm.avoid.map((a) => a.id).sort(), ['claude-work', 'codex-work']);
  assert.equal(vm.bankedPts, 105);
  assert.equal(vm.verdict.word, 'Speed up.');
});

test('every status in the mock maps as designed', () => {
  const s = Object.fromEntries(derive(MOCK).accounts.map((a) => [a.id, a.status]));
  assert.deepEqual(s, {
    'claude-personal': 'onpace',
    'claude-work': 'slowdown',
    'codex-personal': 'useit',
    'codex-work': 'cooked',
    'claude-side': 'pickup',
    'codex-side': 'asleep',
  });
});

test('shifted demo snapshot derives the same as the original', () => {
  const a = derive(MOCK);
  const b = derive(shiftedMock(Date.parse('2027-03-01T09:00:00Z')));
  assert.equal(b.score, a.score);
  assert.equal(b.next.id, a.next.id);
});

test('no 5h limit on the plan is not "asleep"', () => {
  const now = '2026-10-31T12:00:00Z';
  const acct = { id: 'x', provider: 'codex', planSlug: 'pro', fiveHour: null, weekly: { active: true, usedPct: 4, resetsAt: '2026-11-04T12:00:00Z', burnPctPerHour: 0.02 }, dailyPct: [] };
  assert.equal(derive({ now, accounts: [acct], events: [] }).accounts[0].status, 'useit');
});

test('errored accounts are "unknown" and stay out of score and route', () => {
  const now = '2026-10-31T12:00:00Z';
  const good = { id: 'g', provider: 'claude', planSlug: 'pro', fiveHour: { active: true, usedPct: 10, resetsAt: '2026-10-31T14:00:00Z', burnPctPerHour: 5 }, weekly: { active: true, usedPct: 50, resetsAt: '2026-11-03T12:00:00Z', burnPctPerHour: 0.7 }, dailyPct: [] };
  const bad = { id: 'b', provider: 'claude', planSlug: 'max', error: 'token expired', weekly: { active: false, usedPct: 0, resetsAt: null, burnPctPerHour: 0 }, dailyPct: [] };
  const vm = derive({ now, accounts: [bad, good], events: [] });
  assert.equal(vm.accounts[0].status, 'unknown');
  assert.equal(vm.next.id, 'g');
  assert.equal(vm.score, derive({ now, accounts: [good], events: [] }).score);
});

test('meter and sparkline have the requested widths', () => {
  const w = derive(MOCK).accounts[0].week;
  assert.equal(meterGlyphs(w, 30).map((r) => r.text).join('').length, 30);
  assert.ok(meterGlyphs(w, 30).some((r) => r.role === 'pace'));
  const rows = brailleSpark([8, 14, 11, 6, 9, 8, 7], 18, 20);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 18);
  const a = derive(MOCK).accounts[0];
  assert.equal(timelineGlyphs(a, MOCK.now).map((r) => r.text).join('').length, 84);
});

test('adapter maps a live Claude account and a weekly-only Codex account', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const claude = toSlopAccount({
    id: 'c1', provider: 'claude', dir: '/x/.claude-work', email: 'me@acme.com', plan: 'Max 5x',
    windows: [
      { kind: 'session', usedPercent: 38, resetsAt: now + 2 * H, idle: false, ratePerHour: 14.3 },
      { kind: 'weekly', usedPercent: 21, resetsAt: now + 46 * H, idle: false, ratePerHour: 0.17 },
    ],
    spark: [],
  }, now);
  assert.equal(claude.planSlug, 'max-5x');
  assert.equal(claude.label, 'acme');
  assert.equal(claude.fiveHour.usedPct, 38);
  assert.ok(claude.launch.includes('CLAUDE_CONFIG_DIR'));

  const codex = toSlopAccount({
    id: 'x1', provider: 'codex', dir: '/x/.codex', email: 'me@acme.com', plan: 'Pro', resetCredits: 0,
    windows: [{ kind: 'weekly', usedPercent: 4, resetsAt: now + 90 * H, idle: false, ratePerHour: 0.02 }],
  }, now);
  assert.equal(codex.fiveHour, null);
  assert.equal(codex.resetCredits, 0);
});

test('daily usage counts gains per day and treats a drop as a reset', () => {
  const now = Date.parse('2026-10-31T12:00:00');
  const today = new Date(now); today.setHours(1, 0, 0, 0);
  const t = today.getTime();
  const days = dailyFromSamples([[t - 24 * H, 10], [t - 23 * H, 14], [t, 90], [t + H, 5], [t + 2 * H, 8]], now);
  assert.equal(days.length, 7);
  assert.equal(days[5], 4); // yesterday: 10 → 14
  assert.equal(days[6], 76 + 5 + 3); // today: 14 → 90, reset → 5, 5 → 8
});

test('event log describes status changes and rank changes', () => {
  const vm = derive(MOCK);
  const prev = {
    day: new Date(MOCK.now).toDateString(), rank: 'vibe coder', score: 70,
    accounts: Object.fromEntries(vm.accounts.map((a) => [a.id, { status: a.id === 'codex-work' ? 'onpace' : a.status, fiveActive: a.five.active, weekReset: a.week.resetsAt }])),
  };
  const ev = diffEvents(prev, vm, MOCK.now);
  assert.deepEqual(ev.map((e) => e.level), ['429', 'RANK']);
  assert.match(ev[0].msg, /codex\/plus work hit the wall/);
  assert.equal(ev[1].msg, 'ranked up: vibe coder → pace keeper');
});

test('team seats are named as team plans, not as personal Max/Pro plans', async () => {
  const { planOf: claudePlan } = await import('../src/providers/claude.mjs');
  const { planOf: codexPlan } = await import('../src/providers/codex.mjs');
  assert.deepEqual(claudePlan({ subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x' }), { plan: 'Team · 5x limits', planSlug: 'team-5x' });
  assert.deepEqual(claudePlan({ subscriptionType: 'team', rateLimitTier: 'default_claude_pro' }), { plan: 'Team', planSlug: 'team' });
  assert.deepEqual(claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), { plan: 'Max 20x', planSlug: 'max-20x' });
  assert.deepEqual(codexPlan('self_serve_business_prolite'), { plan: 'Business · Pro Lite seat', planSlug: 'business' });
  assert.deepEqual(codexPlan('pro'), { plan: 'Pro', planSlug: 'pro' });
});
