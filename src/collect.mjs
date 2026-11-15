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
import { dailyHistory } from './backfill.mjs';
import { log, since } from './log.mjs';

const FETCHERS = { claude: fetchClaude, codex: fetchCodex, muse: fetchMuse };
const HISTORY_DIR = path.join(SLOP_HOME, 'history');
const LEGACY_FILE = path.join(SLOP_HOME, 'history.jsonl');
const HISTORY_KEEP_MS = 35 * 86400_000;
const DAY_MS = 86400_000;
const DAY_FILE = /^\d{4}-\d\d-\d\d\.jsonl$/;

let history = null;
let persisted = null; // keys of samples already on disk, so each process appends a sample once
let legacyNewest = null; // newest t in the pre-day-files history.jsonl, if there is one

const sampleKey = (s) => `${s.t}|${s.id}|${s.kind}`;
/** UTC day, so a sample's file is the same in every time zone. */
export const historyDay = (t) => new Date(t).toISOString().slice(0, 10);
const dayEnded = (file, cutoff) => Date.parse(file.slice(0, 10)) + DAY_MS <= cutoff;

function dayFiles() {
  try { return fs.readdirSync(HISTORY_DIR).filter((f) => DAY_FILE.test(f)); } catch (e) {
    if (e.code !== 'ENOENT') log.warn('history.list_failed', { error: e });
    return [];
  }
}

function readLines(file, into) {
  let unparsable = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line) try { into.push(JSON.parse(line)); } catch { unparsable++; }
    }
    return { unparsable, found: true };
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('history.read_failed', { error: e });
    return { unparsable, found: false };
  }
}

/**
 * History is append-only: one JSONL file per UTC day under history/, plus the legacy history.jsonl
 * until it ages out. Several processes may append the same sample, so loading dedupes by t|id|kind.
 */
export function loadHistory() {
  if (history) return history;
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  const all = [];
  const legacy = [];
  let { unparsable, found } = readLines(LEGACY_FILE, legacy);
  legacyNewest = found ? Math.max(-Infinity, ...legacy.map((s) => s.t)) : null;
  all.push(...legacy);
  const files = dayFiles().filter((f) => !dayEnded(f, cutoff));
  for (const f of files) unparsable += readLines(path.join(HISTORY_DIR, f), all).unparsable;
  const byKey = new Map(all.filter((s) => s.t >= cutoff).map((s) => [sampleKey(s), s]));
  history = [...byKey.values()].sort((a, b) => a.t - b.t);
  persisted = new Set(byKey.keys());
  log.info('history.loaded', { samples: history.length, unparsable, dayFiles: files.length, legacy: found });
  return history;
}

/** Drops whole days past the cutoff, and the legacy file once none of it is left in the window. */
function pruneHistory(cutoff) {
  for (const f of dayFiles()) if (dayEnded(f, cutoff)) try { fs.unlinkSync(path.join(HISTORY_DIR, f)); } catch {}
  if (legacyNewest !== null && legacyNewest < cutoff) {
    try { fs.unlinkSync(LEGACY_FILE); log.info('history.legacy_removed'); } catch {}
    legacyNewest = null;
  }
}

/**
 * Appends the samples this process hasn't written yet to their day files. Appends never overwrite
 * another process's samples (a `status` run while the server is up), and a crash can at worst
 * leave one torn line, which loading skips.
 */
export function saveSamples(samples) {
  const h = loadHistory();
  const fresh = samples.filter((s) => !persisted.has(sampleKey(s)));
  const byDay = new Map();
  for (const s of fresh) byDay.set(historyDay(s.t), (byDay.get(historyDay(s.t)) || '') + JSON.stringify(s) + '\n');
  if (byDay.size) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  for (const [day, lines] of byDay) fs.appendFileSync(path.join(HISTORY_DIR, `${day}.jsonl`), lines);
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  h.push(...fresh);
  history = h.filter((s) => s.t >= cutoff);
  persisted = new Set(history.map(sampleKey));
  pruneHistory(cutoff);
  log.debug('history.saved', { added: fresh.length, days: byDay.size, kept: history.length, dropped: h.length - history.length });
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
 * Muse's server sends no usage at all until the first use in a new window, so for that case a
 * window keeps its last value until its reset (a lower bound, still flagged stale), and one whose
 * reset has passed is back at 0% and not started. Without a reset time the 12h cutoff still applies.
 */
export function fromLastSamples(a, now, samples = loadHistory()) {
  const latest = {};
  for (const s of samples) if (s.id === a.id && (!latest[s.kind] || s.t > latest[s.kind].t)) latest[s.kind] = s;
  const kinds = Object.values(latest).filter((s) => (a.noUsage && s.resetsAt) || now - s.t < 12 * 3_600_000);
  const ageMin = (list) => (list.length ? Math.round((now - Math.max(...list.map((s) => s.t))) / 60000) : null);
  if (!kinds.length) {
    log.warn('account.no_fallback', { id: a.id, provider: a.provider, error: a.error, newestSampleAgeMin: ageMin(Object.values(latest)) });
    return null;
  }
  log.info('account.fallback_samples', { id: a.id, provider: a.provider, error: a.error, kinds: kinds.map((s) => s.kind), ageMin: ageMin(kinds) });
  const windows = kinds.map((s) => {
    const reset = a.noUsage && s.resetsAt && s.resetsAt <= now;
    return {
      kind: s.kind,
      label: s.kind === 'session' ? (a.provider === 'muse' ? 'Window' : '5-hour') : s.kind === 'weekly' ? 'Weekly' : s.kind.replaceAll('_', ' '),
      usedPercent: reset ? 0 : s.used,
      windowSeconds: s.windowSeconds || (s.kind === 'session' && a.provider === 'muse' ? null : s.kind === 'session' ? 5 * 3600 : 7 * 86400),
      resetsAt: reset ? null : s.resetsAt,
      idle: reset || (!s.resetsAt && s.used === 0),
      observedAt: s.t,
      scope: s.scope || (s.kind === 'weekly_opus' ? 'opus' : s.kind === 'weekly_sonnet' ? 'sonnet' : 'all'),
    };
  });
  const last = new Date(Math.max(...kinds.map((s) => s.t)));
  const at = (last.toDateString() === new Date(now).toDateString() ? '' : `${last.toDateString().slice(0, 10)} `) + last.toTimeString().slice(0, 5);
  return { ...a, windows, observedAt: last.getTime(), error: undefined, stale: true, note: `${a.error}; showing the last reading from ${at}` };
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
