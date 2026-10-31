// Polls every discovered account, remembers recent samples to measure burn rate, and
// produces the snapshot the dashboard and CLI render.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverInstalls, loadConfig, SLOP_HOME } from './discover.mjs';
import { fetchClaude } from './providers/claude.mjs';
import { fetchCodex } from './providers/codex.mjs';
import { analyzeAccount, pickNext } from './pace.mjs';
import { recentRate, completedWindows, weeklyOutlook } from './history.mjs';
import { dailyHistory } from './backfill.mjs';

const FETCHERS = { claude: fetchClaude, codex: fetchCodex };
const HISTORY_FILE = path.join(SLOP_HOME, 'history.jsonl');
const HISTORY_KEEP_MS = 35 * 86400_000;

let history = null;

function loadHistory() {
  if (history) return history;
  history = [];
  try {
    for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      if (line) try { history.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch { /* first run */ }
  return history;
}

function saveSamples(samples) {
  const h = loadHistory();
  h.push(...samples);
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  history = h.filter((s) => s.t >= cutoff);
  fs.mkdirSync(SLOP_HOME, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, history.map((s) => JSON.stringify(s)).join('\n') + '\n');
}

/** Our own weekly readings for an account, for the 7-day history. */
function ownWeeklyReadings(id) {
  return loadHistory()
    .filter((s) => s.id === id && s.kind === 'weekly')
    .map((s) => ({ t: s.t, used: s.used, resetsAt: s.resetsAt }));
}

/** Last 7 days of weekly usage samples, for sparklines. */
function sparkline(id) {
  return loadHistory()
    .filter((s) => s.id === id && s.kind === 'weekly')
    .map((s) => [s.t, s.used]);
}

/**
 * When a live read fails (429, expired token, network), rebuild the windows from the last samples
 * we stored for this account so the dashboard keeps showing something instead of going blank.
 */
function fromLastSamples(a, now) {
  const latest = {};
  for (const s of loadHistory()) if (s.id === a.id && (!latest[s.kind] || s.t > latest[s.kind].t)) latest[s.kind] = s;
  const kinds = Object.values(latest).filter((s) => now - s.t < 12 * 3_600_000);
  if (!kinds.length) return null;
  const windows = kinds.map((s) => ({
    kind: s.kind,
    label: s.kind === 'session' ? '5-hour' : s.kind === 'weekly' ? 'Weekly' : s.kind.replaceAll('_', ' '),
    usedPercent: s.used,
    windowSeconds: s.windowSeconds || (s.kind === 'session' ? 5 * 3600 : 7 * 86400),
    resetsAt: s.resetsAt,
    idle: !s.resetsAt && s.used === 0,
    observedAt: s.t,
    scope: s.scope || (s.kind === 'weekly_opus' ? 'opus' : s.kind === 'weekly_sonnet' ? 'sonnet' : 'all'),
  }));
  const at = new Date(Math.max(...kinds.map((s) => s.t))).toTimeString().slice(0, 5);
  return { ...a, windows, observedAt: Math.max(...kinds.map(s => s.t)), error: undefined, stale: true, note: `${a.error}; showing the last reading from ${at}` };
}

function safeDaily(a, now) {
  try {
    return dailyHistory(a, ownWeeklyReadings(a.id), now);
  } catch (e) {
    console.error('[slopmaxxer] reading history from disk failed:', e.message);
    return null;
  }
}

const accountId = (a) =>
  crypto.createHash('sha1').update(`${a.provider}:${a.accountKey || a.dir}`).digest('hex').slice(0, 10);

export async function collect() {
  const config = loadConfig();
  const installs = discoverInstalls(config);
  const now = Date.now();

  const raw = await Promise.all(
    installs.map((inst) =>
      FETCHERS[inst.provider](inst).catch((e) => ({ provider: inst.provider, dir: inst.dir, error: e.message })),
    ),
  );

  // The same login can live in two dirs — show it once, prefer the one with data.
  const byId = new Map();
  for (const a of raw) {
    const id = accountId(a);
    const prev = byId.get(id);
    if (!prev || ((!prev.windows?.length || prev.stale || prev.error) && a.windows?.length && !a.stale && !a.error)) byId.set(id, { ...a, id, dirs: [...(prev?.dirs || []), a.dir] });
    else prev.dirs.push(a.dir);
  }

  const nicknames = config.nicknames || {};
  const accounts = [...byId.values()].map((a) => (a.error ? fromLastSamples(a, now) || a : a)).map((a) => {
    a.observedAt ??= a.stale || a.error ? null : now;
    a.windows = (a.windows || []).map(w => ({ ...w, observedAt: w.observedAt ?? a.observedAt }));
    const freshSamples = a.stale || a.error ? [] : a.windows.map(w => ({ t: now, id: a.id, kind: w.kind, used: w.usedPercent, resetsAt: w.resetsAt, scope: w.scope, windowSeconds: w.windowSeconds }));
    const evidence = [...loadHistory(), ...freshSamples];
    a.completedWindows = completedWindows(evidence, a.id, now);
    for (const w of a.windows) {
      w.rate = a.stale || a.error ? { confidence: 'learning' } : recentRate(evidence, a.id, w, now);
      if (w.kind === 'weekly') w.outlook = weeklyOutlook(evidence, a.id, w, now);
    }
    const analyzed = analyzeAccount(a, now);
    const { accountKey, ...publicFields } = analyzed;
    return {
      ...publicFields,
      nickname: nicknames[`${a.provider}:${a.email}`] || nicknames[a.id] || nicknames[a.email] || null,
      spark: sparkline(a.id),
      daily: safeDaily(a, now),
    };
  });

  const samples = [];
  for (const a of accounts) {
    if (a.stale || a.error) continue;
    for (const w of a.windows) samples.push({ t: now, id: a.id, kind: w.kind, used: w.usedPercent, resetsAt: w.resetsAt, scope: w.scope, windowSeconds: w.windowSeconds });
  }
  if (samples.length) saveSamples(samples);

  const next = pickNext(accounts, now);
  return {
    generatedAt: now,
    accounts: accounts.sort((a, b) => a.provider.localeCompare(b.provider) || (a.email || '').localeCompare(b.email || '')),
    nextUp: next ? next.id : null,
  };
}
