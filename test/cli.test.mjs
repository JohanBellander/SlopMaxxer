import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const cli = fileURLToPath(new URL('../bin/slopmaxxer.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000,
});
test('help exits without starting the dashboard, from any directory', () => {
  for (const args of [['--help'], ['-h'], ['help'], ['status', '--help']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: slopmaxxer/);
  }
});
test('version matches the package metadata', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});
test('invalid arguments fail promptly with useful errors', () => {
  for (const args of [['wat'], ['--wat'], ['--port'], ['--port', 'abc'], ['--port', '0'], ['--port', '65536'], ['status', '--provider'], ['status', '--provider', 'invalid'], ['accounts', '--json']]) {
    const result = run(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /slopmaxxer --help/);
  }
});
test('status prints local reading times and one shared forecast line per account', () => {
  const result = run('status', '--demo');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Last reading: \d{4}-/);
  assert.match(result.stdout, /Last reading: (sun|mon|tue|wed|thu|fri|sat) \d\d:\d\d, (just now|\d+[mhd] ago)/);
  const accounts = result.stdout.match(/Last reading:/g).length;
  assert.equal(result.stdout.match(/^ {2}Learning your usage\./gm)?.length, accounts);
  assert.doesNotMatch(result.stdout, /^ {4}Learning your usage\./m);
});
test('status --json keeps ISO timestamps', () => {
  const result = run('status', '--demo', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).accounts[0].observedAt, /^\d{4}-\d\d-\d\dT/);
});
