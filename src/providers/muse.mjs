// Muse (Meta): asks the Muse CLI itself for the subscription allowance (`muse usage --json`).
// The token never leaves the CLI — we only read who is logged in from auth.json and never
// read, refresh, or rewrite the credential values in it.
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function planOf(tier, subsActive = false) {
  const plan = tier || (subsActive ? 'Subscription' : null);
  return { plan, planSlug: plan ? plan.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null };
}

function toWindow(kind, label, w, windowSeconds) {
  if (!w) return null;
  const resetsAt = Number.isFinite(w.resetsAtMs) && w.resetsAtMs > 0 ? w.resetsAtMs : null;
  return {
    kind,
    label,
    usedPercent: typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null,
    windowSeconds,
    resetsAt,
    idle: resetsAt == null || resetsAt < Date.now(),
  };
}

function parseUsage(stdout) {
  const text = String(stdout).trim();
  try { return JSON.parse(text); } catch { /* fall through to extraction */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('muse usage printed no JSON');
}

// muse keeps its login under $XDG_CONFIG_HOME/muse (default ~/.config/muse), so point the CLI
// at the discovered home's config root. On Windows `muse` resolves to a .cmd shim, which Node
// can only spawn through a shell; the command is a fixed string, never user input.
async function runMuseUsage(dir) {
  const env = { ...process.env };
  if (dir && path.basename(dir).toLowerCase() === 'muse') env.XDG_CONFIG_HOME = path.dirname(dir);
  const opts = { env, timeout: 15000, windowsHide: true };
  const { stdout } = process.platform === 'win32'
    ? await execAsync('muse usage --json', opts)
    : await execFileAsync('muse', ['usage', '--json'], opts);
  return stdout;
}

export async function fetchMuse({ dir }, { run = runMuseUsage } = {}) {
  const meta = readJson(path.join(dir, 'auth.json'))?.providers?.meta;
  const base = {
    provider: 'muse',
    dir,
    email: meta?.user_email || null,
    name: meta?.user_full_name || null,
    org: null,
    accountKey: meta?.user_email || null,
    ...planOf(null, meta?.subs_active === true),
  };
  // On macOS the CLI keeps the token in the Keychain and auth.json only says so; either way
  // we just check that a login exists and let `muse usage` use it.
  const loggedIn = meta?.access_token || meta?.api_key || meta?.storage === 'keychain';
  if (!loggedIn) return { ...base, error: 'Not logged in (run muse login)' };

  let usage;
  try {
    usage = parseUsage(await run(dir));
  } catch (e) {
    const detail = (e.stderr || '').trim().split('\n')[0] || e.message;
    return { ...base, error: `muse usage failed: ${detail}`, stale: true };
  }
  const a = usage?.allowance;
  if (!a) {
    const reason = usage?.reason === 'server_sent_no_usage' ? 'No usage reported yet — run Muse once to check' : [usage?.reason, usage?.hint].filter(Boolean).join(' — ') || 'no allowance reported';
    return { ...base, error: reason, stale: true, noUsage: usage?.reason === 'server_sent_no_usage' };
  }

  // Muse names its short window just "window" and does not report its length; keep it null
  // rather than guessing (Codex windows do the same when the length is unknown).
  const windows = [
    toWindow('session', 'Window', a.window, null),
    toWindow('weekly', 'Weekly', a.weekly, 7 * 86400),
  ].filter(Boolean);
  const asOf = Number.isFinite(a.asOfMs) && a.asOfMs > 0 ? Math.min(a.asOfMs, Date.now()) : undefined;

  return {
    ...base,
    ...planOf(a.tier, meta?.subs_active === true),
    windows,
    limitReached: windows.some((w) => w.usedPercent >= 100),
    resetCredits: null,
    extraUsage: null,
    observedAt: asOf,
  };
}
