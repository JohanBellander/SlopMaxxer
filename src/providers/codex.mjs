// Codex: uses the ChatGPT login the CLI stored in auth.json to read the same usage numbers as
// /status. Read-only — never refreshes or rewrites auth.json. If the live call fails we fall back
// to the newest rate_limits event in the local session logs.
import fs from 'node:fs';
import path from 'node:path';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

const PLAN_NAMES = {
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  business: 'Business',
  self_serve_business_prolite: 'Business Pro Lite',
  enterprise: 'Enterprise',
  free: 'Free',
};

function labelFor(seconds) {
  if (!seconds) return 'Window';
  if (seconds >= 6 * 86400) return 'Weekly';
  const h = Math.round(seconds / 3600);
  return `${h}-hour`;
}

function toWindow(w) {
  if (!w) return null;
  const windowSeconds = w.limit_window_seconds ?? (w.window_minutes ? w.window_minutes * 60 : null);
  const resetsAt = w.reset_at ? w.reset_at * 1000 : w.resets_at ? w.resets_at * 1000 : null;
  return {
    kind: windowSeconds >= 6 * 86400 ? 'weekly' : 'session',
    label: labelFor(windowSeconds),
    usedPercent: Number(w.used_percent ?? 0),
    windowSeconds,
    resetsAt,
    idle: resetsAt == null || resetsAt < Date.now(),
  };
}

function newestLoggedLimits(dir) {
  // Walk sessions/YYYY/MM/DD newest-first and grab the last rate_limits event.
  const root = path.join(dir, 'sessions');
  const desc = (p) => {
    try { return fs.readdirSync(p).sort().reverse(); } catch { return []; }
  };
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    for (const f of desc(path.join(root, y, m, d)).filter((f) => f.endsWith('.jsonl'))) {
      const text = fs.readFileSync(path.join(root, y, m, d, f), 'utf8');
      const lines = text.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try {
          const ev = JSON.parse(lines[i]);
          const rl = ev.payload?.rate_limits || ev.rate_limits;
          if (rl) return { rl, at: Date.parse(ev.timestamp) || null };
        } catch { /* partial line */ }
      }
    }
  }
  return null;
}

export async function fetchCodex({ dir }) {
  const auth = readJson(path.join(dir, 'auth.json'));
  const claims = decodeJwt(auth?.tokens?.id_token || '');
  const oa = claims['https://api.openai.com/auth'] || {};
  const base = {
    provider: 'codex',
    dir,
    email: claims.email || null,
    name: claims.name || null,
    org: null,
    accountKey: auth?.tokens?.account_id || oa.chatgpt_account_id || null,
    plan: PLAN_NAMES[oa.chatgpt_plan_type] || oa.chatgpt_plan_type || null,
  };

  if (auth?.auth_mode !== 'chatgpt' || !auth?.tokens?.access_token) {
    return { ...base, error: auth?.OPENAI_API_KEY ? 'API-key login (pay-as-you-go, no plan limits)' : 'Not logged in' };
  }

  let liveError = null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        'ChatGPT-Account-Id': auth.tokens.account_id,
        'User-Agent': 'slopmaxxer',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const u = await res.json();
      const rl = u.rate_limit || {};
      return {
        ...base,
        email: u.email || base.email,
        plan: PLAN_NAMES[u.plan_type] || u.plan_type || base.plan,
        windows: [toWindow(rl.secondary_window), toWindow(rl.primary_window)]
          .filter(Boolean)
          .sort((a, b) => a.windowSeconds - b.windowSeconds),
        limitReached: !!rl.limit_reached,
        resetCredits: u.rate_limit_reset_credits?.available_count ?? null,
        extraUsage: u.credits?.has_credits ? { balance: u.credits.balance } : null,
      };
    }
    liveError = `OpenAI said HTTP ${res.status}`;
  } catch (e) {
    liveError = e.message;
  }

  const logged = newestLoggedLimits(dir);
  if (!logged) return { ...base, error: liveError, stale: true };
  return {
    ...base,
    windows: [toWindow(logged.rl.primary), toWindow(logged.rl.secondary)].filter(Boolean)
      .sort((a, b) => a.windowSeconds - b.windowSeconds),
    resetCredits: null,
    stale: true,
    note: `Live check failed (${liveError}); showing last logged numbers from ${new Date(logged.at).toLocaleString()}`,
  };
}
