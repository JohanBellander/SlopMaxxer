// Polls every discovered account, remembers recent samples to measure burn rate, and
// produces the snapshot the dashboard and CLI render.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverInstalls, loadConfig, SLOP_HOME } from './discover.mjs';
import { fetchClaude } from './providers/claude.mjs';
import { fetchCodex } from './providers/codex.mjs';
import { analyzeAccount, pickNext } from './pace.mjs';

const FETCHERS = { claude: fetchClaude, codex: fetchCodex };
const HISTORY_FILE = path.join(SLOP_HOME, 'history.jsonl');
const HISTORY_KEEP_MS = 8 * 86400_000;

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

/** %/hour over the last ~90 minutes within the same window instance (same reset time). */
function observedRate(id, w, now) {
  const pts = loadHistory().filter(
    (s) => s.id === id && s.kind === w.kind && s.resetsAt === w.resetsAt && now - s.t < 90 * 60_000,
  );
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanH = (last.t - first.t) / 3_600_000;
  if (spanH < 0.25) return null;
  return Math.max(0, (last.used - first.used) / spanH);
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
  if (!kinds.some((s) => s.kind === 'weekly')) return null;
  const windows = kinds.map((s) => ({
    kind: s.kind,
    label: s.kind === 'session' ? '5-hour' : 'Weekly',
    usedPercent: s.used,
    windowSeconds: s.kind === 'session' ? 5 * 3600 : 7 * 86400,
    resetsAt: s.resetsAt && s.resetsAt > now ? s.resetsAt : null,
    idle: !s.resetsAt || s.resetsAt <= now,
  }));
  const at = new Date(Math.max(...kinds.map((s) => s.t))).toTimeString().slice(0, 5);
  return { ...a, windows, error: undefined, stale: true, note: `${a.error}; showing the last reading from ${at}` };
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
    if (!prev || (!prev.windows && a.windows)) byId.set(id, { ...a, id, dirs: [...(prev?.dirs || []), a.dir] });
    else prev.dirs.push(a.dir);
  }

  const nicknames = config.nicknames || {};
  const accounts = [...byId.values()].map((a) => (a.error ? fromLastSamples(a, now) || a : a)).map((a) => {
    const rates = {};
    for (const w of a.windows || []) rates[w.kind] = observedRate(a.id, w, now);
    const analyzed = analyzeAccount(a, now, rates);
    const { accountKey, ...publicFields } = analyzed;
    return {
      ...publicFields,
      nickname: nicknames[`${a.provider}:${a.email}`] || nicknames[a.id] || nicknames[a.email] || null,
      spark: sparkline(a.id),
    };
  });

  const samples = [];
  for (const a of accounts) {
    if (a.stale) continue;
    for (const w of a.windows) samples.push({ t: now, id: a.id, kind: w.kind, used: w.usedPercent, resetsAt: w.resetsAt });
  }
  if (samples.length) saveSamples(samples);

  const next = pickNext(accounts);
  return {
    generatedAt: now,
    accounts: accounts.sort((a, b) => a.provider.localeCompare(b.provider) || (a.email || '').localeCompare(b.email || '')),
    nextUp: next ? next.id : null,
  };
}
