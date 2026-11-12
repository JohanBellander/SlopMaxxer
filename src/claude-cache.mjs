import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.mjs';

const INTERVAL = 5 * 60_000;
const MAX_BACKOFF = 60 * 60_000;
const MAX_AGE = 12 * 60 * 60_000;
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Shared by all processes using the same state directory. Never persist credentials.
export async function cachedClaudeUsage({ home, key, request, now = Date.now }) {
  const dir = path.join(home, 'claude-usage');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  const lock = file + '.lock';
  const result = (state, error = state?.error) => ({
    usage: state?.usage && now() - state.fetchedAt < MAX_AGE ? state.usage : null,
    fetchedAt: state?.fetchedAt,
    cached: true,
    error,
    retryAt: state?.retryAt,
  });
  let state = read(file);
  const cacheId = path.basename(file).slice(0, 10);
  if (state?.retryAt > now()) {
    log.debug('claude_cache.wait', { cacheId, retryInSec: Math.round((state.retryAt - now()) / 1000), failures: state.failures || 0, error: state.error });
    return result(state);
  }
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Recover locks from crashed processes; an empty lock may still be being initialized.
    const owner = read(lock);
    let abandoned = !owner && Date.now() - fs.statSync(lock).mtimeMs > 60_000;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (err) { abandoned = err.code === 'ESRCH'; }
    }
    log[abandoned ? 'warn' : 'debug']('claude_cache.locked', { cacheId, ownerPid: owner?.pid, abandoned });
    if (abandoned) { try { fs.unlinkSync(lock); } catch {} }
    return result(state, 'Claude usage refresh in progress; waiting for shared reading');
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    state = read(file);
    if (state?.retryAt > now()) return result(state);
    let next;
    const t0 = performance.now();
    try {
      const res = await request();
      const ms = Math.round(performance.now() - t0);
      if (res.ok) {
        next = { usage: await res.json(), fetchedAt: now(), retryAt: now() + INTERVAL, failures: 0 };
        log.info('claude_api.ok', { cacheId, ms, status: res.status, keys: Object.keys(next.usage || {}) });
      } else {
        const failures = Math.min((state?.failures || 0) + 1, 10);
        const raw = res.headers.get('retry-after');
        const seconds = raw == null || raw.trim() === '' ? NaN : Number(raw);
        const retryAfter = Number.isFinite(seconds) ? now() + Math.max(0, seconds) * 1000 : Date.parse(raw);
        const delay = res.status === 429 ? Math.min(MAX_BACKOFF, INTERVAL * 2 ** (failures - 1)) : INTERVAL;
        next = { ...state, failures, error: `Anthropic said HTTP ${res.status}`, retryAt: Math.max(now() + delay, Number.isFinite(retryAfter) ? retryAfter : 0) };
        log.warn('claude_api.http_error', { cacheId, ms, status: res.status, retryAfter: raw, failures, backoffMin: Math.round((next.retryAt - now()) / 60000) });
      }
    } catch (e) {
      next = { ...state, error: 'Claude usage request failed', retryAt: now() + INTERVAL };
      log.warn('claude_api.request_failed', { cacheId, ms: Math.round(performance.now() - t0), error: e });
    }
    const temp = file + `.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, file);
    return { ...result(next), cached: !!next.error };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
