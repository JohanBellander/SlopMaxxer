// SlopMaxxer derivation logic: a 1:1 port of design/reference/logic.js as an ES module, shared by
// the browser (public/index.html), the server (event log) and the tests. No DOM.
//
// Two additions over the reference, for real data:
//   - `fiveHour: null` means the plan has no 5-hour limit (e.g. some Codex plans). That is not "asleep".
//   - an account with `error` (or no weekly window) gets status 'unknown' and is left out of score/route.

export const FIVE_H_MIN = 300;
export const WEEK_MIN = 7 * 24 * 60;

export const CFG = {
  useItBelow: 60, // weekly projected % at reset below this → "use it or lose it"
  pickUpBelow: 90, // … below this → "pick it up"
  bankedMinUnused: 10, // a reset "banks" capacity if ≥ this % will be unused
  verdictLow: 95, // score below → "Speed up."
  verdictHigh: 105, // score above → "Slow down."
  scoreCap: 120, // projected % is capped at this when averaging into the score
  timelineDays: 7,
  timelineCellMin: 120, // 1 glyph = 2 hours
};

export const RANKS = [
  { name: 'token graveyard', min: 0 },
  { name: 'prompt tourist', min: 40 },
  { name: 'vibe coder', min: 60 },
  { name: 'pace keeper', min: 85 },
  { name: 'slop maxxer', min: 100 },
  { name: 'rate-limit speedrunner', min: 110 },
];

// status → action shown on the row. pri = sort order (lower = use first).
export const ACTIONS = {
  useit: { statusLabel: 'use it or lose it', action: '▲▲ speed up', tone: 'pink', pri: 0 },
  pickup: { statusLabel: 'pick it up', action: '▲ speed up', tone: 'warn', pri: 1 },
  asleep: { statusLabel: 'window asleep', action: '◌ wake it', tone: 'idle', pri: 2 },
  onpace: { statusLabel: 'on pace', action: '● hold', tone: 'ok', pri: 3 },
  slowdown: { statusLabel: 'slow down', action: '▼ slow down', tone: 'hot', pri: 4 },
  cooked: { statusLabel: 'cooked', action: '✕ cooked', tone: 'red', pri: 5 },
  unknown: { statusLabel: 'no data', action: '? no data', tone: 'muted', pri: 6 },
};

const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** One limit window (5h or weekly) → derived numbers. */
export function deriveWindow(w, now, durationMin) {
  if (w === null) return { active: false, none: true, usedPct: 0 };
  if (!w || w.active === false || !w.resetsAt) return { active: false, usedPct: w ? w.usedPct : 0 };
  const remainingMin = Math.max(0, minutesBetween(now, w.resetsAt));
  const remainingH = remainingMin / 60;
  const elapsedMin = durationMin - remainingMin;
  const pacePct = clamp((elapsedMin / durationMin) * 100, 0, 100); // "where you should be by now"
  const projectedPct = Math.round(w.usedPct + w.burnPctPerHour * remainingH); // where you'll land at reset
  const needPctPerHour = remainingH > 0 ? (100 - w.usedPct) / remainingH : 0; // burn that lands exactly on 100%
  const capInMin =
    w.usedPct >= 100 ? 0 : w.burnPctPerHour > 0 && projectedPct > 100 ? ((100 - w.usedPct) / w.burnPctPerHour) * 60 : null;
  return {
    active: true,
    usedPct: w.usedPct,
    pacePct: Math.round(pacePct),
    projectedPct,
    paceDelta: Math.round(w.usedPct - pacePct),
    burnPctPerHour: w.burnPctPerHour,
    needPctPerHour,
    remainingMin,
    resetsAt: w.resetsAt,
    capInMin,
  };
}

export function statusFor(five, week, a = {}) {
  if (a.error || !week.active) return week.usedPct >= 100 ? 'cooked' : 'unknown';
  if (five.usedPct >= 100 || week.usedPct >= 100) return 'cooked';
  if ((five.active && five.projectedPct > 100) || week.projectedPct > 100) return 'slowdown';
  if (!five.active && !five.none) return 'asleep';
  if (week.projectedPct < CFG.useItBelow) return 'useit';
  if (week.projectedPct < CFG.pickUpBelow) return 'pickup';
  return 'onpace';
}

export function derive(snap) {
  const now = snap.now;
  const accounts = snap.accounts.map((a) => {
    const five = deriveWindow(a.fiveHour, now, FIVE_H_MIN);
    const week = deriveWindow(a.weekly, now, WEEK_MIN);
    const status = statusFor(five, week, a);
    const act = ACTIONS[status];
    const known = status !== 'unknown';
    const unusedAtReset = known ? Math.max(0, 100 - Math.min(100, week.projectedPct)) : 0;
    return {
      ...a,
      slug: a.provider + '/' + a.planSlug,
      five,
      week,
      status,
      ...act,
      hunger: known ? week.needPctPerHour - week.burnPctPerHour : -Infinity,
      unusedAtReset,
      banked: unusedAtReset >= CFG.bankedMinUnused,
      events: (snap.events || []).filter((e) => e.accountId === a.id),
    };
  });

  const sorted = accounts.slice().sort((x, y) => x.pri - y.pri || y.hunger - x.hunger);
  const next = sorted.find((a) => !['cooked', 'slowdown', 'unknown'].includes(a.status)) || null;
  const avoid = accounts.filter((a) => a.status === 'cooked' || a.status === 'slowdown');

  const scored = accounts.filter((a) => a.status !== 'unknown');
  const score = scored.length
    ? Math.round(scored.reduce((t, a) => t + Math.min(a.week.projectedPct, CFG.scoreCap), 0) / scored.length)
    : 0;
  const rank = RANKS.slice().reverse().find((r) => score >= r.min);
  const bankedPts = accounts.reduce((t, a) => t + (a.banked ? a.unusedAtReset : 0), 0);

  let verdict;
  if (!scored.length) verdict = { word: 'No data.', arrow: '?', tone: 'muted', why: 'Open Claude Code or Codex once so there is something to read.' };
  else if (score < CFG.verdictLow) verdict = { word: 'Speed up.', arrow: '▲', tone: 'pink', why: `You're leaving ${bankedPts} pts on the table this week.` };
  else if (score > CFG.verdictHigh) verdict = { word: 'Slow down.', arrow: '▼', tone: 'hot', why: "You'll hit caps before the week resets." };
  else verdict = { word: 'Hold.', arrow: '●', tone: 'ok', why: 'Right on pace. Perfectly balanced.' };

  return { now, accounts, sorted, next, avoid, score, rank, verdict, bankedPts, cfg: CFG };
}

/** Plain-English one-liner shown when a row is expanded. */
export function advice(a, fmt) {
  switch (a.status) {
    case 'useit':
      return `Way behind. Needs ${a.week.needPctPerHour.toFixed(2)}%/h to max out, getting ${a.week.burnPctPerHour.toFixed(2)}. Send it your heavy tasks.`;
    case 'pickup':
      return `A bit behind. Throw it a few more tasks before ${fmt.dayTime(a.week.resetsAt)}.`;
    case 'asleep':
      return "Window hasn't started. One prompt starts the 5h clock.";
    case 'onpace':
      return "Right on the line. Keep doing what you're doing.";
    case 'slowdown':
      return a.five.capInMin != null
        ? `Running hot: the 5h window caps in ${fmt.dur(a.five.capInMin)}. Move work elsewhere for a bit.`
        : 'On track to cap the weekly limit before reset. Ease off.';
    case 'cooked': {
      const back = a.five.usedPct >= 100 && a.five.resetsAt ? a.five.resetsAt : a.week.resetsAt;
      return back ? `Rate-limited. Back at ${fmt.dayTime(back)}. Don't bother until then.` : 'Rate-limited.';
    }
    case 'unknown':
      return a.error || "Can't read this account right now.";
  }
  return '';
}

/** Glyph meter: ━ used, dim ━ projected, ─ empty, ╋ pace marker, ┄ asleep. Returns [{text, role}] runs. */
export function meterGlyphs(w, width) {
  if (!w.active) return [{ text: '┄'.repeat(width), role: 'faint' }];
  const out = [];
  const proj = Math.min(w.projectedPct, 100);
  const paceI = Math.min(width - 1, Math.floor((w.pacePct / 100) * width));
  for (let i = 0; i < width; i++) {
    const mid = ((i + 0.5) * 100) / width;
    let role;
    let ch = '━';
    if (i === paceI) { role = 'pace'; ch = '╋'; }
    else if (mid <= w.usedPct) role = 'used';
    else if (mid <= proj) role = 'proj';
    else { role = 'faint'; ch = '─'; }
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += ch;
    else out.push({ text: ch, role });
  }
  return out;
}

/** 7-day refill strip, one glyph per 2h starting at local midnight today. */
export function timelineGlyphs(a, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const cells = (CFG.timelineDays * 24 * 60) / CFG.timelineCellMin;
  const cellOf = (iso) => (iso ? Math.floor(minutesBetween(start, iso) / CFG.timelineCellMin) : -1);
  const nowC = cellOf(now);
  const wkC = a.week.active ? cellOf(a.week.resetsAt) : cells;
  const fvC = a.five.active ? cellOf(a.five.resetsAt) : -1;
  const out = [];
  for (let k = 0; k < cells; k++) {
    let ch, role;
    if (k === nowC) { ch = '▎'; role = 'now'; }
    else if (k === fvC) { ch = '○'; role = 'txt'; }
    else if (k === wkC) { ch = '◆'; role = 'ok'; }
    else if (k < nowC) { ch = '·'; role = 'faint'; }
    else if (k < wkC) { ch = '━'; role = 'used'; }
    else { ch = '─'; role = 'proj'; }
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += ch;
    else out.push({ text: ch, role });
  }
  return out;
}

/** 2-row braille sparkline (8 vertical levels) for daily usage, scaled to maxPct. */
export function brailleSpark(vals, chars, maxPct) {
  if (!vals || !vals.length) vals = [0];
  if (vals.length === 1) vals = [vals[0], vals[0]];
  const cols = chars * 2;
  const pts = [];
  for (let k = 0; k < cols; k++) {
    const t = (k / (cols - 1)) * (vals.length - 1);
    const i = Math.floor(t);
    const f = t - i;
    const v = i + 1 < vals.length ? vals[i] * (1 - f) + vals[i + 1] * f : vals[i];
    pts.push(Math.max(1, Math.round((v / maxPct) * 8)));
  }
  const L = [0x40, 0x4, 0x2, 0x1];
  const R = [0x80, 0x20, 0x10, 0x8];
  const rows = ['', ''];
  for (let c = 0; c < chars; c++) {
    for (let r = 0; r < 2; r++) {
      const base = r === 0 ? 4 : 0;
      const ha = clamp(pts[2 * c] - base, 0, 4);
      const hb = clamp(pts[2 * c + 1] - base, 0, 4);
      let bits = 0;
      for (let j = 0; j < ha; j++) bits |= L[j];
      for (let j = 0; j < hb; j++) bits |= R[j];
      rows[r] += String.fromCharCode(0x2800 + bits);
    }
  }
  return rows;
}
