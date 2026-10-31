#!/usr/bin/env node
// slopmaxxer            → start the local dashboard and open it
// slopmaxxer status     → one-shot terminal overview
// slopmaxxer accounts   → list discovered installs
import { spawn } from 'node:child_process';
import { collect } from '../src/collect.mjs';
import { discoverInstalls } from '../src/discover.mjs';
import { VERDICTS, fmtDuration } from '../src/pace.mjs';
import { startServer } from '../src/server.mjs';

let [cmd = 'serve', ...rest] = process.argv.slice(2);
if (cmd.startsWith('--')) [cmd, rest] = ['serve', [cmd, ...rest]];
const flag = (name) => rest.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};

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
  spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
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
      port: Number(opt('port', process.env.PORT || 4747)),
      demo: flag('demo'),
      onReady: (url) => {
        console.log(`🍝 SlopMaxxer is watching your tokens at ${url}  (Ctrl+C to stop)`);
        if (!flag('no-open')) openBrowser(url);
      },
    });
    break;
  default:
    console.log('usage: slopmaxxer [serve [--port 4747] [--no-open] [--demo] | status [--json] | accounts]');
}
