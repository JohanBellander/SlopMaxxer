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
  for (const args of [['wat'], ['--wat'], ['--port'], ['--port', 'abc'], ['--port', '0'], ['--port', '65536'], ['status', '--demo'], ['accounts', '--json']]) {
    const result = run(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /slopmaxxer --help/);
  }
});
