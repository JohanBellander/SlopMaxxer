import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchMuse, planOf } from '../src/providers/muse.mjs';
import { discoverInstalls } from '../src/discover.mjs';
import { toSlopAccount } from '../src/snapshot.mjs';

const H = 3_600_000;

function museHome(t, meta = { user_email: 'me@gmail.com', user_full_name: 'Me Example', subs_active: true, access_token: 'fake' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-muse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (meta) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ schema_version: 1, providers: { meta } }));
  return dir;
}

function usageJson(now) {
  return JSON.stringify({
    schemaVersion: 1,
    allowance: {
      tier: 'Muse Code Power Usage',
      window: { usedPercent: 13, resetsAtMs: now + 4 * H },
      weekly: { usedPercent: 4, resetsAtMs: now + 11 * H },
      asOfMs: now - 1000,
      source: 'mint',
    },
    reason: null,
    hint: null,
  });
}

test('fetchMuse maps muse usage --json onto SlopMaxxer windows without touching tokens', async (t) => {
  const dir = museHome(t);
  const authBefore = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  const now = Date.now();
  let calls = 0;
  const run = async () => { calls++; return usageJson(now); };
  const result = await fetchMuse({ dir }, { run });
  assert.equal(calls, 1);
  assert.equal(result.provider, 'muse');
  assert.equal(result.email, 'me@gmail.com');
  assert.equal(result.name, 'Me Example');
  assert.equal(result.plan, 'Muse Code Power Usage');
  assert.equal(result.accountKey, 'me@gmail.com');
  assert.equal(result.observedAt, now - 1000);
  assert.equal(result.windows.length, 2);
  const [session, weekly] = result.windows;
  assert.equal(session.kind, 'session');
  assert.equal(session.usedPercent, 13);
  assert.equal(session.resetsAt, now + 4 * H);
  assert.equal(session.windowSeconds, null); // Muse reports no short-window length; don't invent one
  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.usedPercent, 4);
  assert.equal(weekly.windowSeconds, 7 * 86400);
  assert.equal(result.limitReached, false);
  assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), authBefore);
});

test('fetchMuse surfaces a missing allowance and CLI failures as stale errors', async (t) => {
  const dir = museHome(t);
  const noAllowance = async () => JSON.stringify({ schemaVersion: 1, allowance: null, reason: 'no_subscription', hint: 'Subscribe to Muse' });
  const a = await fetchMuse({ dir }, { run: noAllowance });
  assert.equal(a.stale, true);
  assert.match(a.error, /no_subscription/);
  assert.equal(a.windows, undefined);

  const b = await fetchMuse({ dir }, { run: async () => { throw new Error('spawn muse ENOENT'); } });
  assert.equal(b.stale, true);
  assert.match(b.error, /ENOENT/);
});

test('fetchMuse does not call the CLI when no Meta login is stored', async (t) => {
  const dir = museHome(t, null);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ schema_version: 1, providers: {} }));
  let calls = 0;
  const result = await fetchMuse({ dir }, { run: async () => { calls++; return '{}'; } });
  assert.equal(calls, 0);
  assert.match(result.error, /Not logged in/);
});

test('discoverInstalls finds Muse homes named muse with an auth.json', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-muse-disc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'muse');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  const found = discoverInstalls({ extraMuseDirs: [dir] });
  assert.ok(found.some((i) => i.provider === 'muse' && path.resolve(i.dir) === path.resolve(dir)));
});

test('snapshot launches the default Muse home with plain `muse`', () => {
  const now = Date.now();
  const account = toSlopAccount({
    id: 'm1', provider: 'muse', dir: path.join(os.homedir(), '.config', 'muse'),
    email: 'me@gmail.com', plan: 'Muse Code Power Usage',
    windows: [{ kind: 'weekly', usedPercent: 4, resetsAt: now + H, idle: false }],
  }, now);
  assert.equal(account.launch, 'muse');
  assert.equal(account.label, ''); // nicknames only, never the email domain
});

test('planOf slugs the Muse tier and tolerates a missing tier', () => {
  assert.deepEqual(planOf('Muse Code Power Usage'), { plan: 'Muse Code Power Usage', planSlug: 'muse-code-power-usage' });
  assert.deepEqual(planOf(null, true), { plan: 'Subscription', planSlug: 'subscription' });
  assert.deepEqual(planOf(null, false), { plan: null, planSlug: null });
});
