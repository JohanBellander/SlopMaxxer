import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchClaude, localClaudeUsage } from '../src/providers/claude.mjs';
import { CFG } from '../public/guidance.js';

function metadata(now) {
  return {
    oauthAccount: { accountUuid: 'account', organizationUuid: 'org' },
    cachedUsageUtilization: {
      accountUuid: 'account', fetchedAtMs: now - 1000,
      utilization: {
        five_hour: { utilization: 9, resets_at: new Date(now + 3600_000).toISOString() },
        seven_day: { utilization: 27, resets_at: new Date(now + 86400_000).toISOString() },
      },
    },
  };
}

test('rejects wrong-account, old, future, malformed and reset local readings', () => {
  const now = Date.now();
  assert.ok(localClaudeUsage(metadata(now), now));
  for (const mutate of [
    m => { m.cachedUsageUtilization.accountUuid = 'other'; },
    m => { delete m.oauthAccount; },
    m => { m.cachedUsageUtilization.fetchedAtMs = now - 3600_000; },
    m => { m.cachedUsageUtilization.fetchedAtMs = now + 1; },
    m => { m.cachedUsageUtilization.utilization.five_hour.utilization = '9'; },
    m => { m.cachedUsageUtilization.utilization.five_hour.resets_at = 'bad'; },
    m => { m.cachedUsageUtilization.utilization.five_hour.resets_at = new Date(now - 1).toISOString(); },
    m => { delete m.cachedUsageUtilization.utilization.seven_day; },
  ]) {
    const meta = metadata(now); mutate(meta);
    assert.equal(localClaudeUsage(meta, now), null);
  }
});

test('fetchClaude surfaces the stored token expiry without touching credentials', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-exp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expiresAt = Date.now() + 3600_000;
  const creds = path.join(dir, '.credentials.json');
  fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'fake', expiresAt } }));
  const before = fs.readFileSync(creds, 'utf8');
  const meta = metadata(Date.now());
  const request = async () => new Response(JSON.stringify(meta.cachedUsageUtilization.utilization));
  const result = await fetchClaude({ dir }, { home: path.join(dir, 'state'), request });
  assert.equal(result.tokenExpiresAt, expiresAt);
  assert.equal(fs.readFileSync(creds, 'utf8'), before);
});

test('custom Claude home uses local cache without network or writes, then falls back when old', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude.json');
  const creds = path.join(dir, '.credentials.json');
  const meta = metadata(Date.now());
  fs.writeFileSync(file, JSON.stringify(meta));
  fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'fake', expiresAt: Date.now() - 1 } }));
  const before = fs.readFileSync(file, 'utf8');
  const credentials = fs.readFileSync(creds, 'utf8');
  const home = path.join(dir, 'state');
  let calls = 0;
  const request = async () => { calls++; return new Response(JSON.stringify(meta.cachedUsageUtilization.utilization)); };
  const result = await fetchClaude({ dir }, { home, request });
  assert.equal(calls, 0);
  assert.equal(result.windows[0].usedPercent, 9);
  assert.equal(result.windows[1].usedPercent, 27);
  assert.match(result.note, /Claude Code local cache/);
  assert.equal(result.stale, false);
  assert.equal(result.observedAt, meta.cachedUsageUtilization.fetchedAtMs);
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(creds, 'utf8'), credentials);
  meta.cachedUsageUtilization.fetchedAtMs -= 3600_000;
  fs.writeFileSync(file, JSON.stringify(meta));
  fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
  const fallback = await fetchClaude({ dir }, { home, request });
  assert.equal(calls, 1);
  assert.equal(fallback.stale, false);
  await fetchClaude({ dir }, { home, request });
  assert.equal(calls, 1);
});

function login(t, ageMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = metadata(Date.now());
  meta.cachedUsageUtilization.fetchedAtMs = Date.now() - ageMs;
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
  const home = path.join(dir, 'state');
  // The shared cache file for this login, keyed by account as fetchClaude does.
  const shared = path.join(home, 'claude-usage', crypto.createHash('sha256').update('account:org').digest('hex') + '.json');
  return { dir, home, meta, usage: meta.cachedUsageUtilization.utilization, shared };
}

test('local cache is used only while guidance can call it fresh, following CFG.freshMinutes', async (t) => {
  const recent = login(t, 3 * 60_000);
  const used = await fetchClaude({ dir: recent.dir }, { home: recent.home, request: () => assert.fail('network') });
  assert.equal(used.stale, false);
  assert.equal(used.observedAt, recent.meta.cachedUsageUtilization.fetchedAtMs);

  const old = login(t, 10 * 60_000);
  let calls = 0;
  const before = Date.now();
  const live = await fetchClaude({ dir: old.dir }, { home: old.home, request: async () => { calls++; return new Response(JSON.stringify(old.usage)); } });
  assert.equal(calls, 1);
  assert.equal(live.stale, false);
  assert.ok(live.observedAt >= before);

  const saved = CFG.freshMinutes;
  t.after(() => { CFG.freshMinutes = saved; });
  CFG.freshMinutes = 15;
  assert.ok(localClaudeUsage(old.meta));
  CFG.freshMinutes = saved;
  assert.equal(localClaudeUsage(old.meta), null);
});

test('a shared-cache reading is fresh, a lock wait is not a failure, a failed refresh is stale', async (t) => {
  const s = login(t, 10 * 60_000);
  const first = await fetchClaude({ dir: s.dir }, { home: s.home, request: async () => new Response(JSON.stringify(s.usage)) });
  const again = await fetchClaude({ dir: s.dir }, { home: s.home, request: () => assert.fail('network') });
  assert.equal(again.stale, false);
  assert.equal(again.observedAt, first.observedAt);

  // Another live process holds the refresh lock; the reading it leaves us is recent.
  fs.writeFileSync(s.shared, JSON.stringify({ usage: s.usage, fetchedAt: Date.now() - 60_000, retryAt: Date.now() - 1, failures: 0 }));
  fs.writeFileSync(s.shared + '.lock', JSON.stringify({ pid: process.pid }));
  const waiting = await fetchClaude({ dir: s.dir }, { home: s.home, request: () => assert.fail('network') });
  fs.unlinkSync(s.shared + '.lock');
  assert.equal(waiting.stale, false);
  assert.match(waiting.note, /refresh in progress/);

  fs.writeFileSync(s.shared, JSON.stringify({ usage: s.usage, fetchedAt: Date.now() - 6 * 60_000, retryAt: Date.now() - 1, failures: 0 }));
  const failed = await fetchClaude({ dir: s.dir }, { home: s.home, request: async () => new Response('', { status: 500 }) });
  assert.equal(failed.stale, true);
  assert.match(failed.note, /HTTP 500/);
});
