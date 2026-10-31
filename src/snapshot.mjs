// Adapter: turns what collect() reads from the real CLIs into the design's SlopSnapshot
// (design/types.ts), and writes the event log from changes between snapshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLOP_HOME } from './discover.mjs';
import { derive } from '../public/slop.js';

const EVENTS_FILE = path.join(SLOP_HOME, 'events.jsonl');
const STATE_FILE = path.join(SLOP_HOME, 'state.json');
const EVENTS_KEEP = 300;
const DAY = 86400_000;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function toWindow(w) {
  if (!w) return null;
  return {
    active: !w.idle && !!w.resetsAt,
    usedPct: Math.round(w.usedPercent),
    resetsAt: iso(w.resetsAt),
    burnPctPerHour: Math.round((w.ratePerHour || 0) * 1000) / 1000,
  };
}

/** % of the weekly cap used on each of the last 7 local days (oldest first), from weekly samples. */
export function dailyFromSamples(samples, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Array(7).fill(0);
  const first = start.getTime() - 6 * DAY;
  for (let i = 1; i < samples.length; i++) {
    const [t, used] = samples[i];
    const prev = samples[i - 1][1];
    const gain = used >= prev ? used - prev : used; // a drop means the week reset
    const d = Math.floor((t - first) / DAY);
    if (d >= 0 && d < 7) days[d] += gain;
  }
  return days.map((v) => Math.round(v * 10) / 10);
}

function launchCommand(a) {
  const isDefault = (a.dirs || [a.dir]).some((d) => path.resolve(d) === path.join(os.homedir(), `.${a.provider}`));
  if (isDefault) return a.provider;
  const env = a.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  return process.platform === 'win32' ? `$env:${env}="${a.dir}"; ${a.provider}` : `${env}="${a.dir}" ${a.provider}`;
}

const slugify = (s) => String(s || 'unknown').toLowerCase().trim().replace(/\s+/g, '-');

export function toSlopAccount(a, now = Date.now()) {
  const by = (kind) => (a.windows || []).find((w) => w.kind === kind);
  const domain = (a.email || '').split('@')[1]?.split('.')[0];
  return {
    id: a.id,
    provider: a.provider,
    plan: a.plan || 'unknown plan',
    planSlug: a.planSlug || slugify(a.plan),
    label: a.nickname || domain || path.basename(a.dir || ''),
    email: a.email || a.dir,
    fiveHour: a.windows ? toWindow(by('session')) : undefined,
    weekly: toWindow(by('weekly')) || { active: false, usedPct: 0, resetsAt: null, burnPctPerHour: 0 },
    dailyPct: dailyFromSamples(a.spark || [], now),
    // extras the design doesn't have, shown in the expanded row
    resetCredits: a.resetCredits ?? null,
    stale: !!a.stale,
    note: a.note || null,
    error: a.error || null,
    launch: launchCommand(a),
    dirs: a.dirs || [a.dir],
  };
}

// ---- event log --------------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readEvents() {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

const hm = (isoStr) => { const d = new Date(isoStr); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`);

/** Compare the new derived view with the previous state and describe what changed. */
export function diffEvents(prev, vm, nowIso) {
  const out = [];
  const ev = (level, accountId, msg) => out.push({ ts: nowIso, level, accountId, msg });
  const today = new Date(nowIso).toDateString();
  if (prev.day && prev.day !== today) ev('CRON', null, 'gm. feed the slop today');

  for (const a of vm.accounts) {
    const name = `${a.slug} ${a.label}`;
    const p = prev.accounts?.[a.id];
    if (!p) {
      ev('INFO', a.id, `found ${name} · ${a.email}`);
      continue;
    }
    if (p.weekReset && a.week.resetsAt && Date.parse(a.week.resetsAt) - Date.parse(p.weekReset) > 3600_000) {
      ev('CRON', a.id, `weekly refill landed · ${name}`);
    }
    if (p.status !== 'unknown' && p.fiveActive === false && a.five.active) ev('INFO', a.id, `5h window opened · ${name}`);
    if (p.status === a.status) continue;
    switch (a.status) {
      case 'cooked': {
        const back = a.five.usedPct >= 100 ? a.five.resetsAt : a.week.resetsAt;
        ev('429', a.id, `${name} hit the wall. cooked till ${back ? hm(back) : '?'}`);
        break;
      }
      case 'slowdown':
        ev('WARN', a.id, a.five.capInMin != null ? `${name} burning hot · 5h cap in ~${dur(a.five.capInMin)}` : `${name} on track to cap the weekly early`);
        break;
      case 'useit': ev('TIP', a.id, `${name} is starving. feed the slop`); break;
      case 'pickup': ev('WARN', a.id, `${name} ${Math.abs(a.week.paceDelta)}pt behind the pace line`); break;
      case 'onpace': ev('INFO', a.id, `${name} back on pace`); break;
      case 'asleep': ev('INFO', a.id, `${name} asleep · send a prompt to start the 5h clock`); break;
      case 'unknown': ev('WARN', a.id, `${name}: ${a.error || 'no data'}`); break;
    }
  }
  if (prev.rank && prev.rank !== vm.rank.name) {
    const up = (prev.score ?? 0) < vm.score;
    ev('RANK', null, `ranked ${up ? 'up' : 'down'}: ${prev.rank} → ${vm.rank.name}`);
  }
  return out;
}

function stateOf(vm, nowIso) {
  return {
    day: new Date(nowIso).toDateString(),
    rank: vm.rank.name,
    score: vm.score,
    accounts: Object.fromEntries(
      vm.accounts.map((a) => [a.id, { status: a.status, fiveActive: a.five.active, weekReset: a.week.resetsAt || null }]),
    ),
  };
}

/** Build the SlopSnapshot from a collect() result, appending any new events to the log. */
export function buildSlopSnapshot(collected, { ms = null, persist = true } = {}) {
  const now = collected.generatedAt;
  const nowIso = iso(now);
  const accounts = collected.accounts.map((a) => toSlopAccount(a, now));
  const vm = derive({ now: nowIso, accounts, events: [] });

  let events = readEvents();
  if (persist) {
    const fresh = diffEvents(readJson(STATE_FILE, {}), vm, nowIso);
    if (fresh.length) {
      events = [...events, ...fresh].slice(-EVENTS_KEEP);
      fs.mkdirSync(SLOP_HOME, { recursive: true });
      fs.writeFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    fs.mkdirSync(SLOP_HOME, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateOf(vm, nowIso)));
  }

  const ok = accounts.filter((a) => !a.error).length;
  const sync = { ts: nowIso, level: 'INFO', accountId: null, msg: `sync ok · ${ok}/${accounts.length} accounts${ms != null ? ` · ${ms}ms` : ''}` };
  return { now: nowIso, accounts, events: [sync, ...events.slice().reverse()] };
}
