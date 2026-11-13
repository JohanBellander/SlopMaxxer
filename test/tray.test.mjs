import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { trayCommand, startTray, TRAY_SCRIPT, MENUBAR_SCRIPT } from '../src/tray.mjs';

test('tray runs on Windows and macOS only and can be turned off', () => {
  assert.equal(trayCommand({ url: 'http://127.0.0.1:4747' }, { platform: 'linux' }), null);
  assert.equal(trayCommand({ url: 'http://127.0.0.1:4747', enabled: false }, { platform: 'win32' }), null);
  assert.equal(trayCommand({ url: 'http://127.0.0.1:4747', enabled: false }, { platform: 'darwin' }), null);
});

test('macOS menu bar runs the shipped JXA script against the local API', () => {
  const cmd = trayCommand({ url: 'http://127.0.0.1:4747/' }, { platform: 'darwin', pid: 4242 });
  assert.equal(cmd.file, '/usr/bin/osascript');
  assert.deepEqual(cmd.args, ['-l', 'JavaScript', MENUBAR_SCRIPT, 'http://127.0.0.1:4747/api/slop', 'http://127.0.0.1:4747', '4242']);
  assert.equal(fs.existsSync(MENUBAR_SCRIPT), true);
});

// The script is JXA; its menu model is plain JS, so run it here without Cocoa.
const menubar = vm.runInNewContext(fs.readFileSync(MENUBAR_SCRIPT, 'utf8') + ';({ menuModel })');
const now = Date.parse('2026-11-13T12:00:00Z');
const slop = {
  guidance: { verdict: { word: 'Speed up.', arrow: '▲', tone: 'pink', why: 'Use it before reset.' },
    next: { provider: 'codex', slug: 'codex/pro', label: 'personal', status: 'underused' } },
  accounts: [
    { provider: 'codex', planSlug: 'pro', label: 'personal', windows: [
      { kind: 'session', label: '5-hour', active: true, usedPct: 12, resetsAt: '2026-11-13T15:30:00Z' },
      { kind: 'weekly_opus', label: 'Weekly · Opus', active: true, usedPct: 1, resetsAt: null }] },
    { provider: 'claude', planSlug: 'team-5x', label: '', error: 'Token expired', windows: [] },
    { provider: 'claude', planSlug: 'pro', label: 'side', fiveHour: { active: false, usedPct: 0, resetsAt: null }, weekly: { active: true, usedPct: 95, resetsAt: '2026-11-15T12:00:00Z' } },
  ],
};

test('the menu bar shows the server verdict and what is left, without re-deciding it', () => {
  const { title, rows } = menubar.menuModel(slop, now, now);
  const text = rows.map((r) => r.text || '---');
  assert.equal(title, '▲ Speed up.');
  assert.equal(rows[1].color, 'pink');
  assert.ok(text.includes('next task → codex/pro personal'));
  assert.ok(text.includes('  5-hour  █████████░ 88% left · resets 3h 30m'));
  assert.ok(!text.some((l) => l.includes('Opus'))); // only session + weekly, like the tray
  assert.ok(text.includes('  Token expired'));
  assert.ok(text.includes('  5-hour  ██████████ 100% left, not started'));
  assert.equal(rows.find((r) => r.text?.includes('5% left')).color, 'warn');
  const src = fs.readFileSync(MENUBAR_SCRIPT, 'utf8');
  assert.doesNotMatch(src, /meaningfulPct|underusedGap|routeScore/);
  assert.doesNotMatch(src, /'Slow down\.'|'Keep cooking\.'|'Cooldown\.'/);
});

test('the menu bar drops an old verdict and says when the server is gone', () => {
  assert.equal(menubar.menuModel(slop, now, now - 11 * 60_000).title, 'slop');
  const down = menubar.menuModel(null, now);
  assert.equal(down.title, 'slop');
  assert.equal(down.rows[0].text, 'SlopMaxxer is not reachable.');
});

test('the menu bar never polls in the background', () => {
  const src = fs.readFileSync(MENUBAR_SCRIPT, 'utf8');
  // Fetches start only at launch, on menu open and on Refresh now; the timer only collects results.
  assert.equal(src.match(/fetchNow\(\);/g).length, 3);
  assert.match(src, /'tick:'[\s\S]*?fetchDone\(\)/);
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
  // Owner-drawn headline: ink-bounds placement keeps the arrow/word gap exact at
  // any display scaling, where two Labels placed by measured widths overlapped.
  assert.match(ps, /Draw-VerdictHeadline/);
  assert.match(ps, /Text-InkBounds/);
  // Movement only, no fade - in the tray or in the dashboard's keyframes.
  assert.doesNotMatch(ps, /0\.35 \* \$lift/);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /@keyframes urge \{[^}]*opacity/);
  // 1.5s nod cycle, like the dashboard's `urge` keyframes, driven by its own timer.
  assert.match(ps, /% 1500\) \/ 1500/);
  assert.match(ps, /Start-VerdictNod/);
  // Windows animations off (the tray's reduced-motion) means no nod.
  assert.match(ps, /reducedMotion/);
});
