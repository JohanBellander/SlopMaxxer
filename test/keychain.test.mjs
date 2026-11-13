import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { claudeKeychainServices, hasClaudeKeychainLogin, readClaudeKeychainLogin } from '../src/keychain.mjs';
import { fetchClaude } from '../src/providers/claude.mjs';

const home = path.resolve('/Users/me');

test('Keychain service names follow Claude Code: plain for ~/.claude, hashed for other config dirs', () => {
  const hash = (d) => createHash('sha256').update(d).digest('hex').slice(0, 8);
  const main = path.join(home, '.claude'), work = path.join(home, '.claude-work');
  assert.deepEqual(claudeKeychainServices(main, { home }), ['Claude Code-credentials', `Claude Code-credentials-${hash(main)}`]);
  assert.deepEqual(claudeKeychainServices(work, { home }), [`Claude Code-credentials-${hash(work)}`]);
});

test('Keychain lookups are macOS-only and only ever run find-generic-password', async () => {
  const calls = [];
  const run = (file, args) => { calls.push([file, ...args]); return { stdout: '{"claudeAiOauth":{"accessToken":"t"}}' }; };
  assert.equal(hasClaudeKeychainLogin('/d', { platform: 'win32', run }), false);
  assert.equal(await readClaudeKeychainLogin('/d', { platform: 'linux', run }), null);
  assert.equal(calls.length, 0);

  assert.equal(hasClaudeKeychainLogin('/d', { platform: 'darwin', run, home }), true);
  assert.deepEqual(await readClaudeKeychainLogin('/d', { platform: 'darwin', run: async (...a) => run(...a), home }), { claudeAiOauth: { accessToken: 't' } });
  for (const c of calls) {
    assert.equal(c[0], '/usr/bin/security');
    assert.equal(c[1], 'find-generic-password');
  }
  // The existence check never asks for the secret.
  assert.equal(calls[0].includes('-w'), false);
  assert.equal(calls[1].includes('-w'), true);
});

test('a missing Keychain item means no login, not a crash', async () => {
  const fail = () => { throw new Error('The specified item could not be found in the keychain.'); };
  assert.equal(hasClaudeKeychainLogin('/d', { platform: 'darwin', run: fail, home }), false);
  assert.equal(await readClaudeKeychainLogin('/d', { platform: 'darwin', run: async () => fail(), home }), null);
});

test('fetchClaude falls back to the Keychain when .credentials.json is absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-kc-'));
  const keychain = async () => ({ claudeAiOauth: { accessToken: 'kc-token', expiresAt: Date.now() + 3600_000, subscriptionType: 'pro' } });
  let auth = null;
  const request = async (_url, opts) => {
    auth = opts.headers.Authorization;
    return new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null } }), { status: 200 });
  };
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-home-'));
  const a = await fetchClaude({ dir }, { home: home2, request, keychain });
  assert.equal(auth, 'Bearer kc-token');
  assert.equal(a.error, undefined);
  assert.equal(a.plan, 'pro');
});
