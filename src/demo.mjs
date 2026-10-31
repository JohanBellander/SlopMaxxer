// Fake accounts covering every verdict, for `slopmaxxer --demo` and UI work.
import { analyzeAccount, pickNext } from './pace.mjs';

const H = 3_600_000;

export function demoSnapshot(now = Date.now()) {
  const w = (kind, used, hoursLeft, idle = false) => ({
    kind,
    label: kind === 'session' ? '5-hour' : 'Weekly',
    usedPercent: used,
    windowSeconds: kind === 'session' ? 5 * 3600 : 7 * 86400,
    resetsAt: idle ? null : now + hoursLeft * H,
    idle,
  });
  const spark = (from, to, n = 40) =>
    Array.from({ length: n }, (_, i) => [now - (n - i) * 3 * H, Math.round(from + ((to - from) * i) / n + Math.sin(i) * 1.5)]);

  const raw = [
    { id: 'd1', provider: 'claude', email: 'me@work.com', plan: 'Max 20x', org: 'Acme', windows: [w('session', 34, 2.4), w('weekly', 22, 60)], resetCredits: null, spark: spark(0, 22) },
    { id: 'd2', provider: 'claude', email: 'me@home.dev', plan: 'Pro', windows: [w('session', 0, 0, true), w('weekly', 51, 80)], resetCredits: null, spark: spark(10, 51) },
    { id: 'd3', provider: 'codex', email: 'me@work.com', plan: 'Pro', windows: [w('session', 61, 1.2), w('weekly', 40, 14)], resetCredits: 2, spark: spark(5, 40) },
    { id: 'd4', provider: 'codex', email: 'side@proj.io', plan: 'Plus', windows: [w('weekly', 100, 30)], resetCredits: 1, spark: spark(30, 100) },
    { id: 'd5', provider: 'claude', email: 'speedrun@lab.ai', plan: 'Max 5x', windows: [w('session', 70, 1.5), w('weekly', 82, 90)], resetCredits: null, spark: spark(20, 82) },
  ];
  const accounts = raw.map((a) => ({ ...analyzeAccount(a, now, { weekly: a.id === 'd5' ? 1.6 : null }), dirs: [], nickname: null }));
  return { generatedAt: now, accounts, nextUp: pickNext(accounts)?.id ?? null, demo: true };
}
