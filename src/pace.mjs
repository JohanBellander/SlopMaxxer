// Compatibility adapter for raw provider snapshots. All advice comes from guidance.js.
import { derive, deriveWindow, duration } from '../public/guidance.js';
import { toSlopAccount } from './snapshot.mjs';
export const fmtDuration = h => h == null ? 'unknown' : duration(h * 60);
export function analyzeWindow(w, now = Date.now()) {
  const d = deriveWindow({ ...w, usedPct:w.usedPercent, active:!w.idle, observedAt:w.observedAt || now }, now, (w.windowSeconds || 0)/60);
  return { ...w, remainingPercent:d.remainingPct, hoursLeft:d.remainingMin == null ? null : d.remainingMin/60 };
}
export function analyzeAccount(a, now = Date.now()) {
  const vm = derive({ now:new Date(now).toISOString(), accounts:[toSlopAccount(a, now)] });
  const d=vm.accounts[0];
  return { ...a, windows:(a.windows || []).map(w => analyzeWindow(w,now)), verdict:d.status, headline:d.reason, guidance:d };
}
export function pickNext(accounts, now=Date.now()) {
  const vm=derive({now:new Date(now).toISOString(),accounts:accounts.map(a=>toSlopAccount(a,now))});
  return accounts.find(a=>a.id===vm.next?.id) || null;
}
