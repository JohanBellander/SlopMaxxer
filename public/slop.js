// Display helpers; decisions live in the shared guidance module.
export * from './guidance.js';
import { CFG } from './guidance.js';
const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Used allowance only; an even calendar pace is not a target. */
export function meterGlyphs(w, width) {
  if (!w.known || w.none || w.idle) return [{ text: '┄'.repeat(width), role: 'faint' }];
  const used = Math.round(w.usedPct / 100 * width);
  return [{ text: '━'.repeat(used), role: 'used' }, { text: '─'.repeat(width - used), role: 'faint' }];
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
