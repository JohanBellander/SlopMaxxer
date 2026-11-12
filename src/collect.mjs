// Polls every discovered account, remembers recent samples to measure burn rate, and
// produces the snapshot the dashboard and CLI render.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverInstalls, loadConfig, SLOP_HOME } from './discover.mjs';
import { fetchClaude } from './providers/claude.mjs';
import { fetchCodex } from './providers/codex.mjs';
import { fetchMuse } from './providers/muse.mjs';
import { analyzeAccount, pickNext } from './pace.mjs';
import { recentRate, completedWindows, weeklyOutlook } from './history.mjs';
import { dailyHistory, claudeDiskUsage, codexDiskSamples } from './backfill.mjs';
import { log, since } from './log.mjs';

const FETCHERS = { claude: fetchClaude, codex: fetchCodex, muse: fetchMuse };
const HISTORY_FILE = path.join(SLOP_HOME, 'history.jsonl');
const HISTORY_KEEP_MS = 35 * 86400_000;

let history = null;

function loadHistory() {
  if (history) return history;
  history = [];
  let unparsable = 0;
  try {
    for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      if (line) try { history.push(JSON.parse(line)); } catch { unparsable++; }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('history.read_failed', { error: e });
  }
  log.info('history.loaded', { samples: history.length, unparsable });
  return history;
}

function saveSamples(samples) {
  const h = loadHistory();
  h.push(...samples);
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  history = h.filter((s) => s.t >= cutoff);
  fs.mkdirSync(SLOP_HOME, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, history.map((s) => JSON.stringify(s)).join('\n') + '\n');
  log.debug('history.saved', { added: samples.length, kept: history.length, dropped: h.length - history.length });
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
  const ageMin = (list) => (list.length ? Math.round((now - Math.max(...list.map((s) => s.t))) / 60000) : null);
  if (!kinds.length) {
    log.warn('account.no_fallback', { id: a.id, provider: a.provider, error: a.error, newestSampleAgeMin: ageMin(Object.values(latest)) });
    return null;
  }
  log.info('account.fallback_samples', { id: a.id, provider: a.provider, error: a.error, kinds: kinds.map((s) => s.kind), ageMin: ageMin(kinds) });
  const windows = kinds.map((s) => ({
    kind: s.kind,
    label: s.kind === 'session' ? (a.provider === 'muse' ? 'Window' : '5-hour') : s.kind === 'weekly' ? 'Weekly' : s.kind.replaceAll('_', ' '),
    usedPercent: s.used,
    windowSeconds: s.windowSeconds || (s.kind === 'session' && a.provider === 'muse' ? null : s.kind === 'session' ? 5 * 3600 : 7 * 86400),
    resetsAt: s.resetsAt,
    idle: !s.resetsAt && s.used === 0,
    observedAt: s.t,
    scope: s.scope || (s.kind === 'weekly_opus' ? 'opus' : s.kind === 'weekly_sonnet' ? 'sonnet' : 'all'),
  }));
  const at = new Date(Math.max(...kinds.map((s) => s.t))).toTimeString().slice(0, 5);
  return { ...a, windows, observedAt: Math.max(...kinds.map(s => s.t)), error: undefined, stale: true, note: `${a.error}; showing the last reading from ${at}` };
}

function safeDaily(a, now) {
  const t = performance.now();
  try {
    const daily = dailyHistory(a, ownWeeklyReadings(a.id), now);
    log.debug('backfill.done', { id: a.id, provider: a.provider, ms: since(t), source: daily?.source });
    return daily;
  } catch (e) {
    console.error('[slopmaxxer] reading history from disk failed:', e.message);
    log.error('backfill.failed', { id: a.id, provider: a.provider, error: e });
    return null;
  }
}

const accountId = (a) =>
  crypto.createHash('sha1').update(`${a.provider}:${a.accountKey || a.dir}`).digest('hex').slice(0, 10);

/**
 * Read local transcripts and session logs once, so the first poll doesn't. Only reads files on
 * this machine (no provider requests); later polls parse just what was appended since.
 */
export function warmHistory() {
  const t = performance.now();
  let records = 0;
  for (const inst of discoverInstalls(loadConfig())) {
    try {
      if (inst.provider === 'claude') records += claudeDiskUsage(inst.dir).length;
      if (inst.provider === 'codex') records += codexDiskSamples(inst.dir).length;
    } catch (e) {
      log.warn('backfill.warm_failed', { provider: inst.provider, dir: inst.dir, error: e });
    }
  }
  loadHistory();
  log.info('backfill.warmed', { ms: since(t), records });
}

export async function collect() {
  const config = loadConfig();
  const installs = discoverInstalls(config);
  const now = Date.now();
  const t0 = performance.now();
  log.info('collect.start', { installs: installs.map((i) => `${i.provider} ${i.dir}`) });

  const raw = await Promise.all(
    installs.map(async (inst) => {
      const t = performance.now();
      let a;
      try {
        a = await FETCHERS[inst.provider](inst);
      } catch (e) {
        log.error('fetch.threw', { provider: inst.provider, dir: inst.dir, ms: since(t), error: e });
        a = { provider: inst.provider, dir: inst.dir, error: e.message };
      }
      const outcome = a.error ? 'error' : a.stale ? 'stale' : 'live';
      log[outcome === 'live' ? 'info' : 'warn']('fetch.done', {
        provider: inst.provider, dir: inst.dir, id: accountId(a), ms: since(t), outcome,
        plan: a.plan, error: a.error, note: a.note, limitReached: a.limitReached,
        observedAgeMin: a.observedAt ? Math.round((now - a.observedAt) / 60000) : null,
        windows: (a.windows || []).map((w) => ({ kind: w.kind, used: w.usedPercent, resetsInMin: w.resetsAt ? Math.round((w.resetsAt - now) / 60000) : null, idle: w.idle })),
      });
      return a;
    }),
  );

  // The same login can live in two dirs — show it once, prefer the one with data.
  const byId = new Map();
  for (const a of raw) {
    const id = accountId(a);
    const prev = byId.get(id);
    if (!prev || ((!prev.windows?.length || prev.stale || prev.error) && a.windows?.length && !a.stale && !a.error)) byId.set(id, { ...a, id, dirs: [...(prev?.dirs || []), a.dir] });
    else prev.dirs.push(a.dir);
    if (prev) log.debug('account.deduped', { id, provider: a.provider, dirs: byId.get(id).dirs, kept: byId.get(id).dir });
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
  log.info('collect.done', {
    ms: since(t0), installs: installs.length, accounts: accounts.length, samples: samples.length, nextUp: next?.id || null,
    summary: accounts.map((a) => `${a.provider}:${a.id} ${a.error ? 'error' : a.stale ? 'stale' : 'live'}`),
  });
  return {
    generatedAt: now,
    accounts: accounts.sort((a, b) => a.provider.localeCompare(b.provider) || (a.email || '').localeCompare(b.email || '')),
    nextUp: next ? next.id : null,
  };
}
