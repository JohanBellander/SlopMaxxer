import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trayCommand, startTray, TRAY_SCRIPT } from '../src/tray.mjs';

test('tray is Windows-only and can be turned off', () => {
  assert.equal(trayCommand({ url: 'http://127.0.0.1:4747' }, { platform: 'linux' }), null);
  assert.equal(trayCommand({ url: 'http://127.0.0.1:4747' }, { platform: 'darwin' }), null);
  assert.equal(trayCommand({ url: 'http://127.0.0.1:4747', enabled: false }, { platform: 'win32' }), null);
});

test('tray command runs the shipped PowerShell script against the local API', () => {
  const cmd = trayCommand({ url: 'http://127.0.0.1:4747/' }, { platform: 'win32', pid: 4242 });
  assert.equal(cmd.file, 'powershell.exe');
  const args = cmd.args.join('\n');
  assert.match(args, /-STA/);
  assert.match(args, /slopmaxxer-tray\.ps1/);
  assert.match(args, /http:\/\/127\.0\.0\.1:4747\/api\/slop/);
  assert.match(args, /4242/);
  assert.equal(fs.existsSync(TRAY_SCRIPT), true);
});

test('startTray spawns only when a command exists and never throws', () => {
  let calls = 0;
  const fakeChild = { unref() {}, on() {} };
  const spawn = () => { calls++; return fakeChild; };
  assert.equal(startTray({ url: 'http://127.0.0.1:4747' }, { platform: 'linux', spawn }), null);
  assert.equal(calls, 0);
  assert.equal(startTray({ url: 'http://127.0.0.1:4747' }, { platform: 'win32', spawn }), fakeChild);
  assert.equal(calls, 1);
  assert.equal(startTray({ url: 'http://127.0.0.1:4747' }, { platform: 'win32', spawn: () => { throw new Error('no powershell'); } }), null);
});

test('the tray script is a drag-safe click NotifyIcon popup reading the snapshot', () => {
  const ps = fs.readFileSync(TRAY_SCRIPT, 'utf8');
  assert.match(ps, /NotifyIcon/);
  assert.match(ps, /Add_MouseDown/);
  assert.match(ps, /Add_MouseUp/);
  assert.match(ps, /\$moved -le 8/);
  assert.doesNotMatch(ps, /\$notify\.Add_MouseMove/);
  assert.match(ps, /Invoke-RestMethod/);
});

test('the tray popup shows the server-provided verdict instead of re-deciding it', () => {
  const ps = fs.readFileSync(TRAY_SCRIPT, 'utf8');
  // Reads guidance.verdict + guidance.next from /api/slop and renders them.
  assert.match(ps, /lastData\.guidance/);
  assert.match(ps, /slop verdict/);
  assert.match(ps, /next task/);
  assert.match(ps, /Add-WrappedLabel/);
  assert.match(ps, /toneColor/);
  assert.match(ps, /#FF6BB5/); // phosphor --pink, the "Speed up." tone
  // The hover tooltip carries the verdict too, within the NotifyIcon limit.
  assert.match(ps, /Update-Tooltip/);
  assert.match(ps, /Substring\(0, 63\)/);
  // No second decision engine: thresholds and verdict words live in guidance.js only.
  assert.doesNotMatch(ps, /meaningfulPct|underusedGap|routeScore/);
  assert.doesNotMatch(ps, /'Speed up\.'|'Slow down\.'|'Keep cooking\.'|'Cooldown\.'/);
});

test('the tray nods the urgent verdict arrow like the dashboard', () => {
  const ps = fs.readFileSync(TRAY_SCRIPT, 'utf8');
  // Same trigger as the dashboard's .urgent verdict: a next account expiring.
  assert.match(ps, /next\.status -eq 'expiring'/);
  // Dashboard proportions at tray size: taller triangles, a tight gap, a 2px nod
  // (the dashboard's 5px rise at ~60px verdict text, scaled down).
  assert.match(ps, /fontVerdictArrow/);
  assert.match(ps, /Round\(2 \* \$lift\)/);
  // 1.5s nod cycle, like the dashboard's `urge` keyframes, driven by its own timer.
  assert.match(ps, /% 1500\) \/ 1500/);
  assert.match(ps, /Start-VerdictNod/);
  // Windows animations off (the tray's reduced-motion) means no nod.
  assert.match(ps, /reducedMotion/);
});
