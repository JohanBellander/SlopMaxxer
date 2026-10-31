// Exercise the actual npm artifact in an unrelated directory, without real accounts.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'slopmaxxer-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check with npm run test:package');
function run(args, cwd = temp) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
let child;
try {
  const [pack] = JSON.parse(run(['pack', '--json', '--pack-destination', temp], root));
  for (const file of pack.files) {
    assert.match(file.path, /^(bin\/|src\/|public\/|package.json$|README.md$|LICENSE$)/);
  }
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(temp, pack.filename)]);
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  assert.equal(run(['exec', '--offline', '--', 'slopmaxxer', '--version']).trim(), version);
  assert.match(run(['exec', '--offline', '--', 'slopmaxxer', '--help']), /Usage: slopmaxxer/);
  const status = JSON.parse(run(['exec', '--offline', '--', 'slopmaxxer', 'status', '--demo', '--json']));
  assert.ok(status.guidance.next.usable);
  assert.equal(status.nextUp, status.guidance.next.id);
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, [join(temp, 'node_modules/slopmaxxer/bin/slopmaxxer.mjs'), '--demo', '--no-open', '--port', String(port)], {
    cwd: temp, env: { ...process.env, SLOPMAXXER_HOME: join(temp, 'state') }, windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited: ${code}`)); });
    child.stdout.on('data', data => {
      if (String(data).includes('http://')) { clearTimeout(timer); resolve(); }
    });
  });
  for (const path of ['/', '/slop.js', '/guidance.js', '/tokens.css', '/classic', '/api/slop']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert.ok(body.length > 100, path);
    if (path === '/api/slop') assert.ok(JSON.parse(body).accounts.length > 0);
  }
  console.log(`Package verified: ${pack.files.length} files, ${pack.size} bytes; installed CLI and demo dashboard work outside the repo.`);
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  rmSync(temp, { recursive: true, force: true });
}
