import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { redact, redactString, log } from '../src/log.mjs';
import { startServer } from '../src/server.mjs';

test('the diagnostic log is off under node --test unless asked for', () => {
  assert.equal(log.enabled, false);
});

test('redaction removes credentials, emails and the home path', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
  const out = redact({
    accessToken: 'abc', refresh_token: 'def', tokenExpiresAt: 1, Authorization: 'Bearer xyz', email: 'a@b.se',
    nested: { api_key: 'k', note: `Bearer sk-ant-123 for someone@example.com, ${jwt}`, dir: `${os.homedir()}/.claude` },
    error: new Error('failed for x@y.com'),
  });
  assert.equal(out.accessToken, '[redacted]');
  assert.equal(out.refresh_token, '[redacted]');
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.email, '[email]');
  assert.equal(out.nested.api_key, '[redacted]');
  assert.equal(out.nested.dir, '~/.claude');
  assert.doesNotMatch(out.nested.note, /sk-ant|example\.com|eyJ/);
  assert.doesNotMatch(out.error.message, /@/);
  assert.equal(redactString('used 42%'), 'used 42%');
});

test('/api/log accepts small JSON entries only', async (t) => {
  const url = await new Promise((resolve, reject) => {
    const server = startServer({ port: 0, demo: true, onReady: resolve, onError: reject });
    t.after(() => new Promise((r) => server.close(r)));
  });
  const post = (body, type = 'application/json') => fetch(`${url}/api/log`, { method: 'POST', headers: { 'content-type': type }, body });
  assert.equal((await post(JSON.stringify({ level: 'warn', ev: 'load_failed', message: 'x' }))).status, 204);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('{}', 'text/plain')).status, 415);
  assert.equal((await post(JSON.stringify({ pad: 'x'.repeat(9000) }))).status, 413);
});
