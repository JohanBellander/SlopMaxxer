// History that already exists on disk, so the 7-day graph isn't empty on day one.
//
// Codex: every session log under <CODEX_HOME>/sessions records the limit status the server sent
//   (used_percent + resets_at) with a timestamp → exact weekly-% history.
// Claude: transcripts under <CLAUDE_CONFIG_DIR>/projects record tokens per API call, but not the %
//   of the limit. We weight tokens by model price and calibrate against the live weekly % of the
//   current window (used% ÷ weighted tokens since the window started) → an estimate, marked as such.
//
// Files are read incrementally: each poll only parses bytes appended since the last one.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400_000;
const LOOKBACK = 8 * DAY;
const SAME_WINDOW_MS = 15 * 60_000; // concurrent sessions report the same reset a few seconds apart

const cache = new Map(); // file → { size, offset, partial, items[], seen:Set }

function walk(dir, out, sinceMs) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, sinceMs);
    else if (e.name.endsWith('.jsonl')) {
      try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* vanished */ }
    }
  }
  return out;
}

/** Parse only what was appended to `file` since last time. parseLine(line, seen) → item | null. */
function readIncremental(file, parseLine) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return []; }
  let c = cache.get(file);
  if (!c || st.size < c.size) c = { size: 0, offset: 0, partial: '', items: [], seen: new Set() };
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      const text = c.partial + buf.toString('utf8');
      const lines = text.split('\n');
      c.partial = lines.pop(); // last line may still be being written
      for (const l of lines) {
        const it = parseLine(l, c.seen);
        if (it) c.items.push(it);
      }
      c.offset = st.size;
    } finally {
      fs.closeSync(fd);
    }
  }
  c.size = st.size;
  cache.set(file, c);
  return c.items;
}

// ---- Codex ------------------------------------------------------------------------------------

function parseCodexLine(line) {
  if (!line.includes('"rate_limits"')) return null;
  try {
    const j = JSON.parse(line);
    const rl = j.payload?.rate_limits;
    if (!rl) return null;
    const weekly = [rl.primary, rl.secondary].find((w) => w && w.window_minutes >= 6 * 24 * 60);
    if (!weekly || weekly.resets_at == null) return null;
    return { t: Date.parse(j.timestamp), used: Number(weekly.used_percent), resetsAt: weekly.resets_at * 1000 };
  } catch { return null; }
}

/** Weekly limit readings found in a Codex home's session logs: [{t, used, resetsAt}], oldest first. */
export function codexDiskSamples(dir, now = Date.now()) {
  const files = walk(path.join(dir, 'sessions'), [], now - LOOKBACK);
  return files.flatMap((f) => readIncremental(f, parseCodexLine)).filter((s) => s.t >= now - LOOKBACK).sort((a, b) => a.t - b.t);
}

// ---- Claude -----------------------------------------------------------------------------------

// $/MTok (input, output). Only the ratios matter: they turn tokens into "how much of the limit".
const PRICES = [
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus|fable/i, 5, 25],
];

export function weightedUnits(model, u) {
  const [, inP, outP] = PRICES.find(([re]) => re.test(model || '')) || PRICES[2];
  const c1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const c5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - c1h);
  return (
    (u.input_tokens || 0) * inP +
    c5m * inP * 1.25 +
    c1h * inP * 2 +
    (u.cache_read_input_tokens || 0) * inP * 0.1 +
    (u.output_tokens || 0) * outP
  ) / 1e6;
}

function parseClaudeLine(line, seen) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  try {
    const j = JSON.parse(line);
    const m = j.message;
    if (j.type !== 'assistant' || !m?.usage) return null;
    // Claude Code writes one line per content block, each repeating the same usage.
    const key = m.id || j.requestId || j.uuid;
    if (seen.has(key)) return null;
    seen.add(key);
    return { t: Date.parse(j.timestamp), units: weightedUnits(m.model, m.usage) };
  } catch { return null; }
}

/** Price-weighted usage per API call from a Claude config dir's transcripts: [{t, units}]. */
export function claudeDiskUsage(dir, now = Date.now()) {
  const files = walk(path.join(dir, 'projects'), [], now - LOOKBACK);
  return files.flatMap((f) => readIncremental(f, parseClaudeLine)).filter((s) => s.t >= now - LOOKBACK);
}

// ---- turning it into 7 daily bars -------------------------------------------------------------

function dayIndex(t, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.floor((t - (start.getTime() - 6 * DAY)) / DAY); // 0 = six days ago, 6 = today
}

/**
 * % of the weekly cap used per local day, from readings [{t, used, resetsAt}] (any order, any source).
 * Within one window, a day gets the increase of the running max. A new window starts from 0.
 * The very first reading is only a baseline: we don't know when that usage happened.
 */
export function dailyFromReadings(readings, now = Date.now()) {
  const days = Array(7).fill(0);
  const pts = readings.filter((r) => Number.isFinite(r.t) && Number.isFinite(r.used)).sort((a, b) => a.t - b.t);
  let reset = null;
  let max = 0;
  for (const r of pts) {
    let gain;
    const sameWindow = reset != null && r.resetsAt != null && Math.abs(r.resetsAt - reset) <= SAME_WINDOW_MS;
    if (reset == null) gain = 0;
    else if (sameWindow || r.resetsAt == null) gain = Math.max(0, r.used - max);
    else if (r.resetsAt < reset - SAME_WINDOW_MS) continue; // a late straggler from the previous window
    else { gain = r.used; max = 0; } // a fresh window (weekly refill or a banked reset)
    if (r.resetsAt != null && !sameWindow) reset = r.resetsAt;
    max = Math.max(max, r.used);
    const d = dayIndex(r.t, now);
    if (d >= 0 && d < 7) days[d] += gain;
  }
  return days.map((v) => Math.round(v * 10) / 10);
}

/**
 * Estimated % per day from Claude token usage, calibrated on the current weekly window.
 * Only usage before `exactFrom` is estimated (after that we have real readings).
 */
export function claudeEstimatedDaily(usage, weekly, exactFrom, now = Date.now()) {
  const days = Array(7).fill(0);
  if (!weekly?.resetsAt || !usage.length) return { days, factor: null };
  const windowStart = weekly.resetsAt - 7 * DAY;
  const inWindow = usage.filter((u) => u.t >= windowStart && u.t <= now).reduce((s, u) => s + u.units, 0);
  if (inWindow <= 0 || !(weekly.usedPercent > 0)) return { days, factor: null };
  const factor = weekly.usedPercent / inWindow; // % of the weekly cap per weighted unit
  for (const u of usage) {
    if (exactFrom != null && u.t >= exactFrom) continue;
    const d = dayIndex(u.t, now);
    if (d >= 0 && d < 7) days[d] += u.units * factor;
  }
  return { days: days.map((v) => Math.round(v * 10) / 10), factor };
}

/**
 * The 7 daily bars for one account, combining SlopMaxxer's own readings with what's on disk.
 * @returns {{pct:number[], estimated:boolean[], source:string}}
 */
export function dailyHistory(a, ownReadings, now = Date.now()) {
  const dirs = a.dirs || [a.dir];
  const weekly = (a.windows || []).find((w) => w.kind === 'weekly');

  if (a.provider === 'codex') {
    const disk = dirs.flatMap((d) => codexDiskSamples(d, now));
    return { pct: dailyFromReadings([...disk, ...ownReadings], now), estimated: Array(7).fill(false), source: disk.length ? 'codex session logs' : 'own readings' };
  }

  const exact = dailyFromReadings(ownReadings, now);
  const exactFrom = ownReadings.length ? Math.min(...ownReadings.map((r) => r.t)) : null;
  const usage = dirs.flatMap((d) => claudeDiskUsage(d, now));
  const est = claudeEstimatedDaily(usage, weekly, exactFrom, now);
  return {
    pct: exact.map((v, i) => Math.round((v + est.days[i]) * 10) / 10),
    estimated: est.days.map((v) => v > 0),
    source: est.factor ? 'transcripts (estimated) + own readings' : 'own readings',
  };
}
