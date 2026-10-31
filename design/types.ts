// Runtime snapshot contract for /api/slop. Decisions in public/guidance.js are shared by CLI/UI.
export type Provider = 'claude' | 'codex';
export type Status = 'available' | 'expiring' | 'ready' | 'limited' | 'restricted' | 'blocked' | 'checking' | 'stale' | 'unknown';
export interface RateEvidence {
  confidence: 'learning' | 'observed';
  samples?: number;
  spanMinutes?: number;
  low?: number | null;
  high?: number | null;
  perHour?: number;
}
export interface LimitWindow {
  kind: string;
  label: string;
  scope?: 'all' | 'opus' | 'sonnet' | string;
  active: boolean;
  usedPct: number | null;
  resetsAt: string | null;
  observedAt: string | null;
  durationMin?: number | null;
  rate?: RateEvidence;
  outlook?: { confidence: 'learning' | 'limited'; days: number; low?: number; high?: number } | null;
}
export interface CompletedWindow {
  kind: string;
  resetsAt: string;
  observedAt: string;
  usedAtLeast: number;
  unusedAtMost: number;
  gapMinutes: number;
  nearReset: boolean;
}
export interface Account {
  id: string;
  provider: Provider;
  plan: string;
  planSlug: string;
  label: string;
  email: string;
  observedAt: string | null;
  windows: LimitWindow[];
  // Compatibility aliases; missing windows are not automatically assumed to exist.
  fiveHour: LimitWindow | null;
  weekly: LimitWindow | null;
  dailyPct: number[];
  dailyEstimated?: boolean[] | null;
  historySource?: string | null;
  completedWindows: CompletedWindow[];
  stale?: boolean;
  error?: string | null;
  note?: string | null;
  limitReached?: boolean;
  resetCredits?: number | null;
  extraUsage?: object | null;
  launch?: string;
  dirs?: string[];
}
export interface DerivedWindow extends LimitWindow {
  known: boolean;
  none?: boolean;
  idle?: boolean;
  expired?: boolean;
  fresh?: boolean;
  remainingPct: number | null;
  remainingMin?: number | null;
  ageMinutes?: number | null;
  capRange?: [number, number] | null;
  forecast?: 'learning' | 'observed';
}
export type EventLevel = 'INFO' | 'WARN' | 'TIP' | 'CRON' | '429' | 'RANK';
export interface SlopEvent { ts: string; level: EventLevel; accountId: string | null; msg: string; }
export interface SlopSnapshot {
  now: string;
  accounts: Account[];
  events: SlopEvent[];
  previousId?: string | null;
  opportunityMinutes?: number;
  demo?: boolean;
}
export interface GuidanceOptions {
  provider?: 'any' | Provider;
  model?: 'any' | 'opus' | 'sonnet';
  previousId?: string | null;
}
