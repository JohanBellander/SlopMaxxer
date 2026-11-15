import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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

test('the log file never holds a deep secret, and callers cannot forge its core fields', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-log-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const old = path.join(home, 'logs', '2000-01-01.jsonl');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '{}\n');
  const deep = { a: { b: { c: { d: { e: { f: { g: { accessToken: 'synthetic-secret', note: 'Bearer abc synthetic@example.invalid' } } } } } } } };
  const code = `import { log, logFile } from ${JSON.stringify(new URL('../src/log.mjs', import.meta.url).href)};
    log.warn('probe', { deep: ${JSON.stringify(deep)}, t: '1970-01-01T00:00:00.000Z', lvl: 'error', ev: 'forged', pid: 1 });
    process.stdout.write(logFile());`;
  const file = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SLOPMAXXER_HOME: home, SLOPMAXXER_LOG: 'info' }, encoding: 'utf8' });
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /synthetic/);
  const line = JSON.parse(text.trim());
  assert.deepEqual([line.lvl, line.ev, line.t === '1970-01-01T00:00:00.000Z', line.pid === 1], ['warn', 'probe', false, false]);
  assert.equal(fs.existsSync(old), false); // older than 14 days: pruned
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a stopped server still exits by its signal, not as a success', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const child = spawn(process.execPath, [new URL('../bin/slopmaxxer.mjs', import.meta.url).pathname, '--demo', '--no-open', '--no-tray', '--port', String(40000 + Math.floor(Math.random() * 20000))], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.on('data', (d) => /ready/.test(d) && resolve()));
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  assert.deepEqual(await exit, { code: null, signal: 'SIGTERM' });
});
