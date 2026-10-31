import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, meterGlyphs, brailleSpark, timelineGlyphs } from '../public/slop.js';
import { MOCK, shiftedMock } from '../src/mock.mjs';
import { toSlopAccount, dailyFromSamples, diffEvents } from '../src/snapshot.mjs';

const H = 3_600_000;

test('demo uses capacity guidance, not the retired score and ranks', () => {
  const vm = derive(shiftedMock());
  assert.equal(vm.next.id, 'codex-personal');
  assert.equal(vm.accounts.find(a => a.id === 'claude-work').status, 'available');
  assert.equal(vm.accounts.find(a => a.id === 'codex-work').status, 'blocked');
  assert.equal('score' in vm, false);
});

test('meter and sparkline have the requested widths without a mandatory pace marker', () => {
  const vm = derive(shiftedMock());
  const w = vm.accounts[0].week;
  assert.equal(meterGlyphs(w, 30).map(r => r.text).join('').length, 30);
  assert.ok(!meterGlyphs(w, 30).some(r => r.role === 'pace'));
  assert.equal(brailleSpark([8, 14, 11, 6, 9, 8, 7], 18, 20)[0].length, 18);
  assert.equal(timelineGlyphs(vm.accounts[0], vm.now).map(r => r.text).join('').length, 84);
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

test('events describe observed capacity changes without fabricated HTTP errors or ranks', () => {
  const snap = shiftedMock();
  const vm = derive(snap);
  const prev = { accounts: Object.fromEntries(vm.accounts.map(a => [a.id, { status: a.id === 'codex-work' ? 'available' : a.status }])) };
  const events = diffEvents(prev, vm, snap.now);
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'WARN');
  assert.match(events[0].msg, /allowance used up/);
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
