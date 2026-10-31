// The brain: turns "x% used, resets at T" into "pick up / slow down / you're cooked".

export const VERDICTS = {
  COOKED: { emoji: '🔥', title: 'COOKED', tone: 'bad' },
  SLOW_DOWN: { emoji: '🧊', title: 'SLOW DOWN', tone: 'warn' },
  LOSE_IT: { emoji: '🚨', title: 'USE IT OR LOSE IT', tone: 'urgent' },
  PICK_UP: { emoji: '🍝', title: 'FEED THE SLOP', tone: 'urgent' },
  IDLE: { emoji: '😴', title: 'WINDOW ASLEEP', tone: 'idle' },
  ON_PACE: { emoji: '✨', title: 'ON PACE', tone: 'good' },
  MAXXED: { emoji: '👑', title: 'MAXXED', tone: 'good' },
  WAIT: { emoji: '⏳', title: 'WAIT FOR RESET', tone: 'warn' },
  UNKNOWN: { emoji: '❓', title: 'NO DATA', tone: 'idle' },
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * @param w window {usedPercent, windowSeconds, resetsAt, idle}
 * @param observedRate optional measured %/hour from recent history
 */
export function analyzeWindow(w, now = Date.now(), observedRate = null) {
  const used = clamp(w.usedPercent, 0, 100);
  const remaining = 100 - used;
  const windowH = (w.windowSeconds || 0) / 3600;

  if (w.idle || !w.resetsAt) {
    return {
      ...w,
      verdict: used >= 100 ? 'COOKED' : 'IDLE',
      hoursLeft: null,
      expectedPercent: 0,
      delta: 0,
      ratePerHour: 0,
      projectedPercent: used,
      neededPerHour: null,
      hoursToCap: null,
    };
  }

  const hoursLeft = Math.max(0, (w.resetsAt - now) / 3_600_000);
  const elapsedH = clamp(windowH - hoursLeft, 0, windowH);
  const expectedPercent = windowH ? (elapsedH / windowH) * 100 : 0;
  const delta = used - expectedPercent;
  const avgRate = elapsedH > 0.05 ? used / elapsedH : 0;
  // Prefer what you're doing *right now*, but don't let one quiet sample erase the trend.
  const ratePerHour = observedRate != null ? observedRate * 0.7 + avgRate * 0.3 : avgRate;
  const projectedPercent = used + ratePerHour * hoursLeft;
  const neededPerHour = hoursLeft > 0 ? remaining / hoursLeft : null;
  const hoursToCap = ratePerHour > 0 ? remaining / ratePerHour : null;

  const isWeekly = windowH >= 24;
  let verdict;
  if (used >= 99.5) verdict = 'COOKED';
  else if (hoursToCap != null && hoursToCap < hoursLeft * 0.8 && delta > (isWeekly ? 8 : 15)) verdict = 'SLOW_DOWN';
  else if (isWeekly && hoursLeft < 24 && remaining > 25) verdict = 'LOSE_IT';
  else if (!isWeekly && hoursLeft < 1 && remaining > 40) verdict = 'LOSE_IT';
  else if (delta < (isWeekly ? -12 : -25)) verdict = 'PICK_UP';
  else if (used >= 90) verdict = 'MAXXED';
  else verdict = 'ON_PACE';

  return { ...w, verdict, hoursLeft, expectedPercent, delta, ratePerHour, projectedPercent, neededPerHour, hoursToCap };
}

const SPICY = {
  COOKED: ['Absolutely cooked. Touch grass until {reset}.', 'Tank empty. The slop machine rests until {reset}.'],
  SLOW_DOWN: ['Easy, speed demon — at this rate you hit the wall {early} early.', 'You are overcooking. Cap in ~{cap}, reset in {left}.'],
  LOSE_IT: ['{remaining}% evaporates in {left}. Queue the big refactor NOW.', 'Tokens are melting: {remaining}% left, {left} to go. Go go go.'],
  PICK_UP: ['You are {behind}% behind pace. Spin up another agent.', 'Slacking detected: {behind}% under pace. The slop must flow.'],
  IDLE: ['5h window not started — send a prompt to start the clock.', 'Window is asleep. Poke it so the timer starts ticking.'],
  ON_PACE: ['Right on pace. Keep the slop flowing.', 'Perfectly balanced, as all things should be.'],
  MAXXED: ['Peak slopmaxxing achieved.', 'You squeezed this one dry. Respect.'],
  WAIT: ['5h window tapped — weekly still has room. Back in {reset}.', 'Session limit hit. Refuel at {reset}, then go again.'],
  UNKNOWN: ['Can\'t read this one right now.'],
};

export function fmtDuration(h) {
  if (h == null || !isFinite(h)) return '—';
  if (h < 1 / 60) return 'now';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return mm ? `${hh}h ${mm}m` : `${hh}h`;
  }
  const d = Math.floor(h / 24);
  return `${d}d ${Math.round(h - d * 24)}h`;
}

function spicy(verdict, w, seed) {
  const opts = SPICY[verdict] || SPICY.UNKNOWN;
  const line = opts[seed % opts.length];
  return line
    .replace('{reset}', w?.resetsAt ? new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'later')
    .replace('{early}', fmtDuration((w?.hoursLeft ?? 0) - (w?.hoursToCap ?? 0)))
    .replace('{cap}', fmtDuration(w?.hoursToCap))
    .replace('{left}', fmtDuration(w?.hoursLeft))
    .replace('{remaining}', Math.round(100 - (w?.usedPercent ?? 0)))
    .replace('{behind}', Math.round(-(w?.delta ?? 0)));
}

/** Decide the one thing to tell the user about an account. */
export function analyzeAccount(acct, now = Date.now(), rates = {}) {
  if (!acct.windows?.length) {
    return { ...acct, windows: [], verdict: 'UNKNOWN', headline: acct.error || 'No data', slopScore: null };
  }
  const windows = acct.windows.map((w) => analyzeWindow(w, now, rates[w.kind] ?? null));
  const weekly = windows.find((w) => w.kind === 'weekly');
  const session = windows.find((w) => w.kind === 'session');

  let verdict;
  let focus;
  if (weekly?.verdict === 'COOKED') [verdict, focus] = ['COOKED', weekly];
  else if (session?.verdict === 'COOKED') [verdict, focus] = ['WAIT', session];
  else if (weekly?.verdict === 'SLOW_DOWN' || session?.verdict === 'SLOW_DOWN') {
    focus = weekly?.verdict === 'SLOW_DOWN' ? weekly : session;
    verdict = 'SLOW_DOWN';
  } else if (weekly && ['LOSE_IT', 'PICK_UP'].includes(weekly.verdict)) [verdict, focus] = [weekly.verdict, weekly];
  else if (session?.verdict === 'LOSE_IT') [verdict, focus] = ['LOSE_IT', session];
  else if (session?.verdict === 'IDLE' && weekly && weekly.usedPercent < 99) [verdict, focus] = ['IDLE', session];
  else if (!weekly && session) [verdict, focus] = [session.verdict, session];
  else [verdict, focus] = [weekly?.verdict || 'ON_PACE', weekly || session];

  // SlopScore: how well you're using what's already elapsed of the week (100 = perfectly on pace).
  const ref = weekly || session;
  const slopScore = ref && ref.expectedPercent > 1 ? Math.round(clamp((ref.usedPercent / ref.expectedPercent) * 100, 0, 200)) : null;

  const seed = Math.floor(now / 600_000); // rotate the jokes every 10 minutes
  return { ...acct, windows, verdict, focusKind: focus?.kind, headline: spicy(verdict, focus, seed), slopScore };
}

/** Across all accounts: which one should get your next task? */
export function pickNext(accounts) {
  const usable = accounts.filter((a) => a.windows?.length && !['COOKED', 'WAIT', 'UNKNOWN'].includes(a.verdict));
  if (!usable.length) return null;
  // Most capacity expiring soonest = most urgent. Score = remaining weekly % per hour left.
  const score = (a) => {
    const w = a.windows.find((x) => x.kind === 'weekly') || a.windows[0];
    if (!w.hoursLeft) return 0;
    const sess = a.windows.find((x) => x.kind === 'session');
    const sessHeadroom = sess && !sess.idle ? (100 - sess.usedPercent) / 100 : 1;
    return ((100 - w.usedPercent) / Math.max(w.hoursLeft, 0.5)) * sessHeadroom;
  };
  return usable.sort((a, b) => score(b) - score(a))[0];
}
