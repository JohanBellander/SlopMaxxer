#!/usr/bin/env node
// slopmaxxer            → start the local dashboard and open it
// slopmaxxer status     → one-shot terminal overview
// slopmaxxer accounts   → list discovered installs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { collect } from '../src/collect.mjs';
import { discoverInstalls } from '../src/discover.mjs';
import { VERDICTS, fmtDuration } from '../src/pace.mjs';
import { startServer } from '../src/server.mjs';

const args = process.argv.slice(2);
const usage = `Usage: slopmaxxer [command] [options]

Commands:
  serve       Open the local dashboard (default)
  status      Print a one-shot terminal summary
  accounts    List discovered Claude Code and Codex logins

Options:
  --demo            Show sample accounts (serve)
  --no-open         Start without opening a browser (serve)
  --port <number>   Require port 1–65535 (default: 4747 or a free port)
  --json            Print JSON (status)
  -h, --help        Show help
  -v, --version     Show version

Examples:
  npx slopmaxxer
  npx slopmaxxer --demo
  npx slopmaxxer status --json

Log in with Claude Code or Codex first; existing logins are found automatically.
Keep the terminal open while using the dashboard. Press Ctrl+C to stop.`;
if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
  console.log(usage);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
function fail(message) {
  console.error(`slopmaxxer: ${message}\nRun slopmaxxer --help for usage.`);
  process.exit(1);
}
let [cmd = 'serve', ...rest] = args;
if (cmd.startsWith('-')) [cmd, rest] = ['serve', args];
const allowed = { serve: ['--demo', '--no-open', '--port'], status: ['--json'], accounts: [] };
if (!Object.hasOwn(allowed, cmd)) fail(`Unknown command: ${cmd}`);
for (let i = 0; i < rest.length; i++) {
  if (!allowed[cmd].includes(rest[i])) fail(`Unknown option for ${cmd}: ${rest[i]}`);
  if (rest[i] === '--port' && (!rest[++i] || !/^\d+$/.test(rest[i]))) fail('--port requires a number from 1 to 65535.');
}
const flag = (name) => rest.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const port = Number(opt('port', process.env.PORT || 4747));
if (cmd === 'serve' && (!Number.isInteger(port) || port < 1 || port > 65535)) fail('Port must be a number from 1 to 65535.');

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yel: (s) => `\x1b[33m${s}\x1b[0m`, grn: (s) => `\x1b[32m${s}\x1b[0m`, mag: (s) => `\x1b[35m${s}\x1b[0m` }
  : Object.fromEntries(['dim', 'bold', 'red', 'yel', 'grn', 'mag'].map((k) => [k, (s) => s]));

function bar(used, expected, width = 24) {
  const u = Math.round((Math.min(used, 100) / 100) * width);
  const e = Math.min(width - 1, Math.round((Math.min(expected, 100) / 100) * width));
  let s = '';
  for (let i = 0; i < width; i++) s += i === e ? '│' : i < u ? '█' : '░';
  const col = used >= 90 ? c.red : used < expected - 12 ? c.mag : c.grn;
  return col(s);
}

async function status() {
  const snap = await collect();
  if (flag('json')) return console.log(JSON.stringify(snap, null, 2));
  console.log(c.bold('\n  🍝 SlopMaxxer') + c.dim(`  ·  ${new Date(snap.generatedAt).toLocaleTimeString()}\n`));
  for (const a of snap.accounts) {
    const v = VERDICTS[a.verdict];
    const who = a.nickname || a.email || a.dir;
    const next = snap.nextUp === a.id ? c.yel('  ← next task goes here') : '';
    console.log(`  ${a.provider === 'claude' ? '🟠' : '⚫'} ${c.bold(who)} ${c.dim(`${a.provider} · ${a.plan || '?'}${a.org ? ' · ' + a.org : ''}`)}${next}`);
    console.log(`     ${v.emoji} ${c.bold(v.title)}  ${a.headline}`);
    for (const w of a.windows) {
      const pct = `${Math.round(w.usedPercent)}%`.padStart(4);
      const left = w.idle ? c.dim('not started') : `resets in ${fmtDuration(w.hoursLeft)}`;
      console.log(`     ${w.label.padEnd(16)} ${bar(w.usedPercent, w.expectedPercent)} ${pct}  ${c.dim(left)}`);
    }
    if (a.resetCredits) console.log(`     🎟️  ${a.resetCredits} banked reset(s) available`);
    if (a.note) console.log(c.dim(`     ${a.note}`));
    console.log();
  }
  if (!snap.accounts.length) console.log('  No Claude Code or Codex logins found. Log in with `claude` or `codex` first.\n');
}

function openBrowser(url) {
  const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(bin, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => console.error(`Could not open a browser. Open ${url} manually.`));
  child.unref();
}

switch (cmd) {
  case 'status':
    await status();
    break;
  case 'accounts':
    for (const i of discoverInstalls()) console.log(`${i.provider.padEnd(7)} ${i.dir}`);
    break;
  case 'serve':
    startServer({
      port,
      fallbackPort: !rest.includes('--port') && !process.env.PORT,
      demo: flag('demo'),
      onReady: (url) => {
        const link = process.stdout.isTTY
          ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`
          : url;
        console.log(`\nSlopMaxxer is ready\n\n  ${link}\n\nOpen the link in your browser (Ctrl+click in Windows Terminal).\nKeep this terminal open. Press Ctrl+C to stop.\n`);
        if (!flag('no-open')) openBrowser(url);
      },
      onError: (error) => fail(error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Choose another port, for example:\n  npx slopmaxxer@latest --port ${port === 65535 ? 4747 : port + 1}\n`
        : `Could not start the dashboard: ${error.message}`),
    });
    break;
  default:
    console.log('usage: slopmaxxer [serve [--port 4747] [--no-open] [--demo] | status [--json] | accounts]');
}
