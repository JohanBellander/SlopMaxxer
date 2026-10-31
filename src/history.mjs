// Readings are percentages, never credentials or transcript content.
const H = 3600000, DAY = 24 * H;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const quantile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
};

export function recentRate(history, id, w, now) {
  const points = history.filter(s => s.id === id && s.kind === w.kind && s.resetsAt === w.resetsAt &&
    s.t <= now && now - s.t <= 90 * 60000 && finite(s.used)).sort((a, b) => a.t - b.t);
  const learning = { confidence: 'learning', samples: points.length, spanMinutes: 0, low: null, high: null };
  if (!w.resetsAt || points.length < 4) return learning;
  const spanMinutes = (points.at(-1).t - points[0].t) / 60000;
  if (spanMinutes < 30 || now - points.at(-1).t > 5 * 60000) return { ...learning, spanMinutes };
  const rates = [];
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0) continue;
    if (dt > 10 * 60000 || points[i].used < points[i - 1].used) return { ...learning, spanMinutes };
    // Use overlapping 15-minute spans to reduce integer percentage quantization noise.
    const first = points.find(p => p.t >= points[i].t - 20 * 60000 && p.t <= points[i].t - 15 * 60000);
    if (first) rates.push((points[i].used - first.used) / ((points[i].t - first.t) / H));
  }
  if (rates.length < 2) return { ...learning, spanMinutes };
  const low = quantile(rates, .2), high = quantile(rates, .8);
  return { confidence: 'observed', samples: points.length, spanMinutes, low, high,
    perHour: (points.at(-1).used - points[0].used) / (spanMinutes / 60) };
}

export function completedWindows(history, id, now) {
  const groups = new Map();
  for (const s of history) {
    if (s.id !== id || !finite(s.used) || !s.resetsAt || s.resetsAt > now || s.t > s.resetsAt) continue;
    const key = `${s.kind}:${s.resetsAt}`;
    if (!groups.has(key) || groups.get(key).t < s.t) groups.set(key, s);
  }
  return [...groups.values()].filter(last => !history.some(s => s.id === id && s.kind === last.kind && s.t > last.t && s.t < last.resetsAt && s.resetsAt !== last.resetsAt)).filter(last => history.some(s => s.id === id && s.kind === last.kind &&
    s.t >= last.resetsAt && s.resetsAt > last.resetsAt))
    .sort((a, b) => b.resetsAt - a.resetsAt).slice(0, 20).map(s => ({
      kind: s.kind, resetsAt: new Date(s.resetsAt).toISOString(), observedAt: new Date(s.t).toISOString(),
      usedAtLeast: Math.min(100, s.used), unusedAtMost: Math.max(0, 100 - s.used),
      gapMinutes: Math.round((s.resetsAt - s.t) / 60000), nearReset: s.resetsAt - s.t <= 10 * 60000,
    }));
}

// Estimate calendar-day demand only from days with near-continuous observation.
// Offline gaps are unknown, never counted as idle time. This is a range, not a cap prediction.
export function weeklyOutlook(history, id, w, now) {
  const days = new Map();
  const pts = history.filter(s => s.id === id && s.kind === w.kind && finite(s.used) && s.t >= now - 14 * DAY && s.t <= now).sort((a,b) => a.t-b.t);
  const today = Math.floor(now / DAY);
  for (let i=1; i<pts.length; i++) {
    const a=pts[i-1], b=pts[i], dt=b.t-a.t, day=Math.floor(b.t/DAY);
    if (dt <= 0 || dt > 10*60000 || day === today || Math.floor(a.t/DAY) !== day || a.resetsAt !== b.resetsAt || b.used < a.used) continue;
    const d=days.get(day) || { coverage:0, usage:0 };
    d.coverage+=dt; d.usage+=b.used-a.used; days.set(day,d);
  }
  const observed=[...days.values()].filter(d => d.coverage >= 18*H).map(d => d.usage);
  if (observed.length < 5 || !w.resetsAt || w.resetsAt <= now || !finite(w.usedPercent)) return { confidence:'learning', days:observed.length };
  const remaining=(w.resetsAt-now)/DAY;
  return { confidence:'limited', days:observed.length,
    low:Math.round(w.usedPercent + quantile(observed,.2)*remaining),
    high:Math.round(w.usedPercent + quantile(observed,.8)*remaining) };
}
