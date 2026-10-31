import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchClaude, localClaudeUsage } from '../src/providers/claude.mjs';

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
  assert.equal(result.stale, true);
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
