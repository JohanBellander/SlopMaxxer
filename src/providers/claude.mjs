// Claude Code: reads the OAuth token the CLI already stored and asks Anthropic for the same
// numbers `/usage` shows. Read-only: we never refresh or rewrite credentials, so we can't
// break the real CLI's login. An expired token just means "open Claude once to refresh".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLOP_HOME } from '../discover.mjs';
import { cachedClaudeUsage } from '../claude-cache.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function metadata(dir) {
  // Default install keeps account info in ~/.claude.json; CLAUDE_CONFIG_DIR installs keep it inside the dir.
  const isDefault = path.resolve(dir).toLowerCase() === path.join(os.homedir(), '.claude').toLowerCase();
  return readJson(isDefault ? path.join(os.homedir(), '.claude.json') : path.join(dir, '.claude.json'))
    || readJson(path.join(dir, '.claude.json'));
}

function identity(meta) {
  const acct = meta?.oauthAccount || {};
  return {
    email: acct.emailAddress || null,
    name: acct.displayName || acct.fullName || null,
    org: acct.organizationName || null,
    accountKey: acct.accountUuid ? `${acct.accountUuid}:${acct.organizationUuid || ''}` : null,
  };
}

// Claude Code's private on-disk format: fail closed if the account, age, or shape is unknown.
export function localClaudeUsage(meta, now = Date.now()) {
  const cache = meta?.cachedUsageUtilization;
  if (!meta?.oauthAccount?.accountUuid || cache?.accountUuid !== meta.oauthAccount.accountUuid) return null;
  if (!Number.isFinite(cache.fetchedAtMs) || cache.fetchedAtMs > now || now - cache.fetchedAtMs >= 3600_000) return null;
  const usage = cache.utilization;
  if (!usage || !usage.five_hour || !usage.seven_day) return null;
  for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    const w = usage[key];
    if (w == null) continue;
    if (!Number.isFinite(w.utilization) || w.utilization < 0 || w.utilization > 100) return null;
    if (w.resets_at != null && (typeof w.resets_at !== 'string' || !Number.isFinite(Date.parse(w.resets_at)) || Date.parse(w.resets_at) <= now)) return null;
  }
  return { usage, fetchedAt: cache.fetchedAtMs, cached: true, source: 'Claude Code local cache' };
}

const TIER_NAMES = {
  default_claude_max_5x: 'Max 5x',
  default_claude_max_20x: 'Max 20x',
  default_claude_pro: 'Pro',
};

// Team/Enterprise seats report a Max-style rate-limit tier too (a Team premium seat has Max 5x
// limits), so the subscription type decides the name and the tier only adds the multiplier.
const ORG_PLANS = { team: 'Team', enterprise: 'Enterprise' };

export function planOf(creds) {
  if (!creds) return { plan: null, planSlug: null };
  const tier = TIER_NAMES[creds.rateLimitTier];
  const org = ORG_PLANS[creds.subscriptionType];
  if (org) {
    const mult = tier?.match(/\d+x/)?.[0];
    return { plan: mult ? `${org} · ${mult} limits` : org, planSlug: org.toLowerCase() + (mult ? '-' + mult : '') };
  }
  const plan = tier || creds.subscriptionType || creds.rateLimitTier || null;
  return { plan, planSlug: plan ? plan.toLowerCase().replace(/\s+/g, '-') : null };
}

function toWindow(kind, label, w, windowSeconds) {
  if (!w) return null;
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : null;
  return {
    kind,
    label,
    usedPercent: typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? w.utilization : null,
    windowSeconds,
    resetsAt,
    // A rolling 5h window that hasn't been started has no reset yet.
    idle: resetsAt == null || resetsAt < Date.now(),
  };
}

export async function fetchClaude({ dir }, { home = SLOP_HOME, request = fetch } = {}) {
  const creds = readJson(path.join(dir, '.credentials.json'))?.claudeAiOauth;
  const meta = metadata(dir);
  const id = identity(meta);
  const base = {
    provider: 'claude',
    dir,
    ...id,
    ...planOf(creds),
  };
  if (!creds?.accessToken) return { ...base, error: 'Not logged in (no OAuth token)' };
  const local = localClaudeUsage(meta);
  if (!local && creds.expiresAt && creds.expiresAt < Date.now()) {
    return { ...base, error: 'Token expired — open Claude Code once and it refreshes itself', stale: true };
  }

  const reading = local || await cachedClaudeUsage({
    home,
    key: id.accountKey || creds.accessToken,
    request: () => request(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'slopmaxxer',
      },
      signal: AbortSignal.timeout(15000),
    }),
  });
  const retry = reading.error && reading.retryAt ? `; next attempt after ${new Date(reading.retryAt).toISOString()}` : '';
  if (!reading.usage) return { ...base, error: (reading.error || 'No recent Claude usage reading') + retry, stale: true };
  const u = reading.usage;

  const windows = [
    toWindow('session', '5-hour', u.five_hour, 5 * 3600),
    toWindow('weekly', 'Weekly', u.seven_day, 7 * 86400),
    toWindow('weekly_opus', 'Weekly · Opus', u.seven_day_opus, 7 * 86400),
    toWindow('weekly_sonnet', 'Weekly · Sonnet', u.seven_day_sonnet, 7 * 86400),
  ].filter(Boolean);

  return {
    ...base,
    stale: reading.cached,
    note: reading.cached ? `${reading.error ? reading.error + '; ' : ''}${reading.source || 'cached Claude reading'} from ${new Date(reading.fetchedAt).toISOString()}${retry}` : undefined,
    windows,
    extraUsage: u.extra_usage?.is_enabled
      ? { utilization: u.extra_usage.utilization, currency: u.extra_usage.currency }
      : null,
    resetCredits: null,
  };
}
