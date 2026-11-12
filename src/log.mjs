// Local diagnostic log: one JSON object per line in ~/.slopmaxxer/logs/YYYY-MM-DD.jsonl.
// It never leaves the machine and must never hold a credential or an email address:
// accounts are named by their hashed id, secrets are scrubbed before anything is written.
// SLOPMAXXER_LOG=debug|info|warn|error|off (default info; off under `node --test`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };
const KEEP_DAYS = 14;
// Same rule as discover.mjs SLOP_HOME; duplicated so discover.mjs can log without an import cycle.
export const LOG_DIR = path.join(process.env.SLOPMAXXER_HOME || path.join(os.homedir(), '.slopmaxxer'), 'logs');

const configured = (process.env.SLOPMAXXER_LOG || '').toLowerCase();
const threshold = LEVELS[configured] ?? (process.env.NODE_TEST_CONTEXT ? LEVELS.off : LEVELS.info);

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|cookie|credential/i;
const EMAIL_KEY = /^(email|user_email|emailAddress)$/i;
const HOME = os.homedir();

/** Scrub anything that looks like a credential or an email, and shorten home paths. */
export function redactString(s) {
  return s
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[jwt]')
    .replace(/\b(sk|rk|pk)-[\w-]{16,}/g, '[key]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .split(HOME).join('~');
}

export function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return { message: redactString(value.message), code: value.code, stack: value.stack && redactString(value.stack.split('\n').slice(0, 6).join('\n')) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : EMAIL_KEY.test(k) ? (v ? '[email]' : v) : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

let prunedFor = null;
function prune(today) {
  if (prunedFor === today) return;
  prunedFor = today;
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      const day = Date.parse(f.slice(0, 10));
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && day < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch { /* nothing to prune */ }
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function logFile(d = new Date()) {
  return path.join(LOG_DIR, `${localDay(d)}.jsonl`);
}

function write(level, ev, fields) {
  if (LEVELS[level] < threshold) return;
  const d = new Date();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    prune(localDay(d));
    const line = JSON.stringify({ t: d.toISOString(), lvl: level, ev, pid: process.pid, ...redact(fields || {}) });
    fs.appendFileSync(logFile(d), line + '\n');
  } catch { /* logging must never break the tool */ }
}

export const log = {
  enabled: threshold < LEVELS.off,
  debug: (ev, f) => write('debug', ev, f),
  info: (ev, f) => write('info', ev, f),
  warn: (ev, f) => write('warn', ev, f),
  error: (ev, f) => write('error', ev, f),
};

/** Milliseconds since `t0`, rounded. */
export const since = (t0) => Math.round(performance.now() - t0);
