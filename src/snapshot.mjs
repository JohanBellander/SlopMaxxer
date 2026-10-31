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

function toWindow(w, observedAt) {
  if (!w) return null;
  return {
    kind: w.kind, label: w.label || w.kind,
    scope: w.scope || (w.kind === 'weekly_opus' ? 'opus' : w.kind === 'weekly_sonnet' ? 'sonnet' : 'all'),
    active: !w.idle, usedPct: w.usedPercent,
    resetsAt: iso(w.resetsAt), observedAt: iso(w.observedAt ?? observedAt),
    durationMin: w.windowSeconds ? w.windowSeconds / 60 : null,
    rate: w.rate || { confidence: 'learning' }, outlook: w.outlook || null,
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
  const isDefault = (a.dirs || [a.dir]).some((d) => d && path.resolve(d) === path.join(os.homedir(), `.${a.provider}`));
  if (isDefault || !a.dir) return a.provider;
  const env = a.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  return process.platform === 'win32' ? `$env:${env}="${a.dir}"; ${a.provider}` : `${env}="${a.dir}" ${a.provider}`;
}

const slugify = (s) => String(s || 'unknown').toLowerCase().trim().replace(/\s+/g, '-');

export function toSlopAccount(a, now = Date.now()) {
  const observedAt = a.observedAt ?? (a.stale || a.error ? null : now);
  const windows = (a.windows || []).map(w => toWindow(w, observedAt));
  const by = kind => windows.find(w => w.kind === kind) || null;
  const domain = (a.email || '').split('@')[1]?.split('.')[0];
  return {
    id: a.id,
    provider: a.provider,
    plan: a.plan || 'unknown plan',
    planSlug: a.planSlug || slugify(a.plan),
    label: a.nickname || domain || path.basename(a.dir || ''),
    email: a.email || a.dir,
    windows, observedAt: iso(observedAt),
    fiveHour: by('session'), weekly: by('weekly'),
    completedWindows: a.completedWindows || [],
    limitReached: !!a.limitReached, extraUsage: a.extraUsage || null,
    dailyPct: a.daily?.pct || dailyFromSamples(a.spark || [], now),
    dailyEstimated: a.daily?.estimated || null,
    historySource: a.daily?.source || null,
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

/** Describe observed changes, never manufacture HTTP 429 events from a forecast. */
export function diffEvents(prev, vm, nowIso) {
  const out = [];
  for (const a of vm.accounts) {
    const p = prev.accounts?.[a.id];
    if (!p || p.status !== a.status) out.push({ ts: nowIso, level: a.status === 'blocked' ? 'WARN' : 'INFO',
      accountId: a.id, msg: `${a.slug} ${a.label}: ${a.action}. ${a.reason}` });
    if (p && a.fresh && a.week.resetsAt && p.weekReset && Date.parse(a.week.resetsAt) > Date.parse(p.weekReset))
      out.push({ ts: nowIso, level: 'INFO', accountId: a.id, msg: `${a.slug} ${a.label}: new weekly window observed.` });
  }
  return out;
}

export function stateOf(vm, nowIso, prev = {}) {
  const interval = (Date.parse(nowIso) - Date.parse(prev.at)) / 60000;
  let opportunityMinutes = prev.opportunityMinutes || 0;
  const mixed = vm.accounts.some(a => a.status === 'blocked') && vm.accounts.some(a => a.usable && a.status !== 'restricted');
  const ids = vm.accounts.filter(a => a.status === 'blocked').map(a => a.id).sort().join(',');
  const available = vm.accounts.filter(a => a.usable && a.status !== 'restricted').map(a => a.id);
  // Count observed intervals only; gaps and reset crossings are not lost work.
  const sameWindows = vm.accounts.every(a => a.windows.every(w => prev.accounts?.[a.id]?.resets?.[w.kind] === w.resetsAt));
  if (mixed && prev.mixed && ids === prev.blockedIds && available.some(id => prev.available?.includes(id)) &&
      sameWindows && interval > 0 && interval <= 5) opportunityMinutes += interval;
  return { version: 2, nextId: vm.next?.id || null, at: nowIso, mixed, blockedIds: ids, available, opportunityMinutes,
    accounts: Object.fromEntries(vm.accounts.map(a => [a.id, { status: a.status, weekReset: a.week.resetsAt,
      resets: Object.fromEntries(a.windows.map(w => [w.kind, w.resetsAt])) }])) };
}

/** Build the SlopSnapshot from a collect() result, appending any new events to the log. */
export function buildSlopSnapshot(collected, { ms = null, persist = true } = {}) {
  const now = collected.generatedAt;
  const nowIso = iso(now);
  const accounts = collected.accounts.map((a) => toSlopAccount(a, now));
  const prev = readJson(STATE_FILE, {});
  const vm = derive({ now: nowIso, accounts, events: [], previousId: prev.version === 2 ? prev.nextId : null });
  const nextState = stateOf(vm, nowIso, prev);
  let events = prev.version === 2 ? readEvents() : [];
  if (persist) {
    const fresh = diffEvents(prev.version === 2 ? prev : {}, vm, nowIso);
    if (fresh.length) {
      events = [...events, ...fresh].slice(-EVENTS_KEEP);
      fs.mkdirSync(SLOP_HOME, { recursive: true });
      fs.writeFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    fs.mkdirSync(SLOP_HOME, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(nextState));
  }

  const ok = accounts.filter((a) => !a.error && !a.stale).length;
  const sync = { ts: nowIso, level: 'INFO', accountId: null, msg: `sync ok · ${ok}/${accounts.length} accounts${ms != null ? ` · ${ms}ms` : ''}` };
  return { now: nowIso, previousId: vm.next?.id || null, opportunityMinutes: nextState.opportunityMinutes, accounts, events: [sync, ...events.slice().reverse()] };
}
