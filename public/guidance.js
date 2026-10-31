// Pure account decisions shared by the browser, CLI and event log. No DOM or I/O.
export const FIVE_H_MIN = 300;
export const WEEK_MIN = 10080;
export const CFG = {
  freshMinutes: 5, limitedPct: 10, meaningfulPct: 20, underusedGapPct: 20,
  sessionOpportunityMinutes: 60, weeklyOpportunityMinutes: 24 * 60,
  forecastHorizonMinutes: 120, switchMargin: 15,
  timelineDays: 7, timelineCellMin: 120,
};
export const ACTIONS = {
  expiring: { action: 'use before reset', tone: 'pink', pri: 0 },
  underused: { action: 'speed up', tone: 'pink', pri: 1 },
  available: { action: 'available', tone: 'ok', pri: 1 },
  ready: { action: 'ready to start', tone: 'idle', pri: 1 },
  restricted: { action: 'model restriction', tone: 'warn', pri: 2 },
  limited: { action: 'limited headroom', tone: 'warn', pri: 3 },
  blocked: { action: 'allowance used up', tone: 'red', pri: 4 },
  checking: { action: 'checking reset', tone: 'muted', pri: 5 },
  stale: { action: 'refresh needed', tone: 'muted', pri: 6 },
  unknown: { action: 'no reliable data', tone: 'muted', pri: 7 },
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const ms = value => typeof value === 'number' ? value : Date.parse(value);
const valid = n => typeof n === 'number' && Number.isFinite(n);
export const duration = m => m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${Math.floor(m % 60)}m` : `${Math.max(1, Math.ceil(m))}m`;

export function deriveWindow(w, now, durationMin = WEEK_MIN) {
  if (w === null) return { none: true, active: false, known: false, usedPct: 0, remainingPct: null };
  if (!w) return { active: false, known: false, usedPct: null, remainingPct: null };
  const known = valid(w.usedPct) && w.usedPct >= 0;
  const usedPct = known ? clamp(w.usedPct, 0, 100) : null;
  const remainingPct = known ? 100 - usedPct : null;
  const reset = ms(w.resetsAt);
  const remainingMin = Number.isFinite(reset) ? Math.max(0, (reset - ms(now)) / 60000) : null;
  const expired = Number.isFinite(reset) && reset <= ms(now);
  const idle = known && usedPct === 0 && w.active === false && !w.resetsAt;
  const observed = ms(w.observedAt);
  const ageMinutes = Number.isFinite(observed) ? Math.max(0, (ms(now) - observed) / 60000) : null;
  const fresh = ageMinutes != null && ageMinutes <= CFG.freshMinutes && observed <= ms(now) + 60000;
  const windowMinutes = valid(w.durationMin) && w.durationMin > 0 ? w.durationMin : durationMin;
  const timeLeftPct = remainingMin != null && windowMinutes > 0 ? clamp(remainingMin / windowMinutes * 100, 0, 100) : null;
  const unusedGapPct = known && timeLeftPct != null ? remainingPct - timeLeftPct : null;
  const rate = w.rate || {};
  const reliable = fresh && !expired && rate.confidence === 'observed' && rate.samples >= 4 && rate.spanMinutes >= 30;
  let capRange = null;
  if (reliable && remainingPct > 0 && valid(rate.low) && valid(rate.high) && rate.low > 0 && rate.high >= rate.low) {
    const early = remainingPct / rate.high * 60, late = remainingPct / rate.low * 60;
    if (late <= CFG.forecastHorizonMinutes && (remainingMin == null || late < remainingMin)) capRange = [Math.max(1, Math.floor(early)), Math.max(1, Math.ceil(late))];
  }
  return { ...w, durationMin: windowMinutes, timeLeftPct, unusedGapPct, known, usedPct, remainingPct, remainingMin,
    active: known && !idle, idle, expired, fresh, ageMinutes, capRange,
    resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
    forecast: reliable ? 'observed' : 'learning',
  };
}

function inputWindows(a) {
  if (Array.isArray(a.windows)) return a.windows;
  return [
    ...(a.fiveHour === null ? [] : [{ ...a.fiveHour, kind: 'session', label: '5-hour' }]),
    ...(a.weekly === null ? [] : [{ ...a.weekly, kind: 'weekly', label: 'Weekly' }]),
    ...(a.additionalWindows || []),
  ];
}

export function deriveAccount(a, now, { model = 'any' } = {}) {
  const windows = inputWindows(a).map(w => deriveWindow({ ...w, observedAt: w.observedAt || a.observedAt }, now,
    w.kind === 'session' ? FIVE_H_MIN : WEEK_MIN));
  const general = windows.filter(w => !w.scope || w.scope === 'all');
  const scoped = windows.filter(w => w.scope && w.scope !== 'all');
  const applicable = windows.filter(w => !w.scope || w.scope === 'all' || w.scope === model);
  const restrictions = scoped.filter(w => !w.known || !w.fresh || w.expired || w.usedPct >= 100);
  const blocked = applicable.filter(w => w.known && w.usedPct >= 100);
  const fresh = !a.stale && !a.error && applicable.length > 0 && applicable.every(w => w.fresh);
  const unknown = !general.length || applicable.some(w => !w.known);
  const checking = applicable.some(w => w.expired);
  const headroom = applicable.length && !unknown ? Math.min(...applicable.map(w => w.remainingPct)) : null;
  const limiting = applicable.filter(w => w.known).sort((x, y) => x.remainingPct - y.remainingPct)[0] || null;
  // A weekly opportunity is not accessible if the short window already blocks use.
  const opportunity = applicable.filter(w => w.known && w.remainingMin > 0 && w.remainingPct >= CFG.meaningfulPct &&
    w.remainingMin <= (w.kind === 'session' ? CFG.sessionOpportunityMinutes : CFG.weeklyOpportunityMinutes))
    .sort((x, y) => x.remainingMin - y.remainingMin)[0] || null;
  // Calendar comparison is a utilization nudge, not a prediction from a short usage burst.
  const underused = applicable.filter(w => w.known && w.fresh && !w.idle && !w.expired &&
    w.remainingMin > 0 && w.remainingPct >= CFG.meaningfulPct && w.unusedGapPct >= CFG.underusedGapPct)
    .sort((x, y) => y.unusedGapPct - x.unusedGapPct)[0] || null;
  const interruption = applicable.filter(w => w.capRange).sort((x, y) => x.capRange[0] - y.capRange[0])[0] || null;
  const recoveryAt = blocked.length && blocked.every(w => w.resetsAt && !w.expired)
    ? new Date(Math.max(...blocked.map(w => ms(w.resetsAt)))).toISOString() : null;
  let status;
  if (a.error || unknown) status = 'unknown';
  else if (!fresh) status = 'stale';
  else if (checking) status = 'checking';
  else if (blocked.length || a.limitReached === true) status = 'blocked';
  else if (model === 'any' && restrictions.length) status = 'restricted';
  else if (headroom <= CFG.limitedPct) status = 'limited';
  else if (opportunity) status = 'expiring';
  else if (underused) status = 'underused';
  else if (applicable.some(w => w.idle)) status = 'ready';
  else status = 'available';
  const usable = ['available', 'expiring', 'underused', 'ready', 'limited', 'restricted'].includes(status);
  let reason;
  if (status === 'unknown') reason = a.error || 'Some applicable limits could not be read. Refresh before choosing this account.';
  else if (status === 'stale') reason = 'Last known values only. Refresh before choosing this account.';
  else if (status === 'checking') reason = 'A reset time has passed. Waiting for a fresh reading to confirm new capacity.';
  else if (status === 'blocked') reason = blocked.length
    ? `${blocked.map(w => w.label).join(' and ')} allowance used up. ${recoveryAt ? `Expected availability after ${new Date(recoveryAt).toISOString()} (confirm after reset).` : 'Next availability is not known.'}`
    : 'The provider reports a limit. Refresh to check when capacity becomes available.';
  else if (status === 'limited') reason = limiting.remainingMin != null && limiting.remainingMin <= 15
    ? `${Math.round(headroom)}% left on ${limiting.label}, resetting in ${duration(limiting.remainingMin)}. Nearly used up before reset; use the remainder for a suitable small task.`
    : `${Math.round(headroom)}% left on ${limiting.label}. Some capacity remains; consider another account for a long task.`;
  else if (status === 'restricted') reason = `${restrictions.map(w => w.label).join(', ')} needs attention. General allowance remains; check the model-specific limits below before starting work.`;
  else if (opportunity) reason = `${Math.round(opportunity.remainingPct)}% of ${opportunity.label} remains with reset in ${duration(opportunity.remainingMin)}. Use it for suitable work before reset.`;
  else if (status === 'underused') reason = `${Math.round(underused.remainingPct)}% of ${underused.label} allowance remains, but only ${Math.round(underused.timeLeftPct)}% of its window is left (${duration(underused.remainingMin)}). Pick up the pace to use more before reset. This compares calendar time, not predicted consumption.`;
  else if (status === 'ready') reason = 'A usage window has not started. Ready when you have a suitable task.';
  else reason = 'Capacity remains on the reported limits. Keep working if this account suits your task.';
  if (status === 'blocked' && opportunity) reason += ` ${opportunity.label} capacity remains, but another limit currently prevents using it.`;
  if (usable && interruption) reason += ` At your recent pace, ${interruption.label} may run out in ${duration(interruption.capRange[0])}–${duration(interruption.capRange[1])}; this is conditional, not a task-size guarantee.`;
  const urgency = opportunity ? 100 + 30 * (1 - opportunity.remainingMin / (opportunity.kind === 'session' ? CFG.sessionOpportunityMinutes : CFG.weeklyOpportunityMinutes)) : underused ? 20 + underused.unusedGapPct : 0;
  const routeScore = usable ? (headroom || 0) * .4 + urgency - (status === 'limited' ? 60 : 0) - (status === 'restricted' ? 80 : 0) : -1000;
  const absent = deriveWindow(null, now);
  return { ...a, windows, applicable, five: windows.find(w => w.kind === 'session') || absent,
    week: windows.find(w => w.kind === 'weekly') || absent, slug: `${a.provider}/${a.planSlug || 'account'}`,
    status, ...ACTIONS[status], usable, headroom, limiting, opportunity: usable ? opportunity : null,
    interruption: usable ? interruption : null, restrictions, recoveryAt: status === 'blocked' ? recoveryAt : null,
    reason, routeScore, fresh, events: [],
  };
}

export function derive(snap, options = {}) {
  const now = snap.now;
  const accounts = (snap.accounts || []).map(a => ({ ...deriveAccount(a, now, options), events: (snap.events || []).filter(e => e.accountId === a.id) }));
  const matches = a => (!options.provider || options.provider === 'any' || a.provider === options.provider) && (!options.model || options.model === 'any' || a.provider === 'claude');
  const candidates = accounts.filter(a => a.usable && a.status !== 'restricted' && matches(a));
  candidates.sort((a, b) => b.routeScore - a.routeScore || a.id.localeCompare(b.id));
  let next = candidates[0] || null;
  const previous = candidates.find(a => a.id === (options.previousId || snap.previousId));
  if (previous && next && next.routeScore - previous.routeScore < CFG.switchMargin) next = previous;
  const selected = accounts.filter(matches);
  const allBlocked = selected.length > 0 && selected.every(a => a.status === 'blocked');
  const recoveries = selected.filter(a => a.recoveryAt).map(a => a.recoveryAt).sort();
  let verdict;
  if (next) verdict = {
    word: ['expiring', 'underused'].includes(next.status) ? 'Speed up.' : next.status === 'limited' ? 'Slow down.' : 'Keep cooking.',
    arrow: next.status === 'expiring' ? '▲▲' : next.status === 'underused' ? '▲' : next.status === 'limited' ? '▼' : '▶',
    tone: ['expiring', 'underused'].includes(next.status) ? 'pink' : next.status === 'limited' ? 'warn' : 'ok',
    why: next.status === 'expiring' ? `The reset clock is ticking. ${next.reason}` : next.reason,
  };
  else if (allBlocked) verdict = { word: 'Cooldown.', arrow: '▼', tone: 'warn',
    why: recoveries.length ? `Earliest known availability: ${recoveries[0]}. Confirm after reset.` : 'Reset time is unknown. Refresh to check availability.' };
  else if (selected.some(a => a.status === 'restricted')) verdict = { word: 'Check model limits.', arrow: '▶', tone: 'warn', why: 'General capacity remains, but a model-specific limit needs attention.' };
  else verdict = { word: selected.length ? 'Refresh before deciding.' : 'No matching accounts.', arrow: '?', tone: 'muted',
    why: selected.length ? 'Readings are missing, stale, or awaiting reset confirmation.' : 'Log in with Claude Code or Codex, or change the provider filter.' };
  const sorted = accounts.slice().sort((a, b) => (a.id === next?.id ? -1 : b.id === next?.id ? 1 : a.pri - b.pri || b.routeScore - a.routeScore || a.id.localeCompare(b.id)));
  return { now, accounts, sorted, next, avoid: accounts.filter(a => !a.usable), verdict,
    availableCount: candidates.length, cfg: CFG, opportunityMinutes: snap.opportunityMinutes || 0 };
}

export function advice(a) { return a.reason; }
export function windowSummary(w) {
  if (w.none) return 'Not applicable';
  if (!w.known) return 'Could not read this limit';
  if (w.expired) return `${Math.round(w.remainingPct)}% last known remaining · checking reset`;
  if (w.idle) return 'Not started · clock begins when the provider opens the window';
  return `${Math.round(w.remainingPct)}% left · ${w.remainingMin == null ? 'reset time unknown' : `resets in ${duration(w.remainingMin)}`}`;
}
export function forecastSummary(w) {
  if (!w.fresh || w.expired || !w.known) return 'Forecast unavailable until refreshed.';
  if (w.capRange) return `About ${duration(w.capRange[0])}–${duration(w.capRange[1])} of use left if your recent pace continues. Task sizes vary.`;
  if (w.forecast === 'observed') return 'Recent usage observed; no supported estimate of a cap within the next two hours.';
  return 'Learning your usage. Not enough consistent recent history for an interruption estimate.';
}
