// SlopMaxxer data model. The UI only ever consumes a SlopSnapshot; provider adapters produce it.

export type Provider = 'claude' | 'codex';

/** One usage-limit window as reported by the provider. Percentages are of that window's cap (0–100+). */
export interface LimitWindow {
  /** false when no window is open yet (e.g. the 5h clock hasn't started). */
  active: boolean;
  usedPct: number;
  /** ISO-8601 with offset. null when inactive. */
  resetsAt: string | null;
  /** Recent burn rate in % of this window's cap per hour (suggested: average over the last 2h). */
  burnPctPerHour: number;
}

export interface Account {
  id: string;                 // stable, e.g. 'claude-personal'
  provider: Provider;
  plan: string;               // display, e.g. 'Max 20x'
  planSlug: string;           // used in the slug 'claude/max-20x'
  label: string;              // user's own tag: 'personal' | 'work' | 'side' | …
  email: string;
  fiveHour: LimitWindow;
  weekly: LimitWindow;
  /** Usage per day for the last 7 days, oldest first, in % of the weekly cap. */
  dailyPct: number[];
}

export type EventLevel = 'INFO' | 'WARN' | 'TIP' | '429' | 'RANK' | 'CRON';

export interface SlopEvent {
  ts: string;                 // ISO-8601
  level: EventLevel;
  accountId: string | null;   // null = global event
  msg: string;
}

export interface SlopSnapshot {
  now: string;                // ISO-8601, the time the snapshot was taken
  accounts: Account[];
  events: SlopEvent[];        // newest first
}

// ---- derived (see reference/logic.js → derive) ----

export type Status = 'useit' | 'pickup' | 'asleep' | 'onpace' | 'slowdown' | 'cooked';

export interface DerivedWindow {
  active: boolean;
  usedPct: number;
  pacePct: number;            // "where you should be by now" = elapsed / duration × 100
  projectedPct: number;       // usedPct + burn × hoursRemaining
  paceDelta: number;          // usedPct − pacePct (negative = behind)
  burnPctPerHour: number;
  needPctPerHour: number;     // (100 − usedPct) / hoursRemaining
  remainingMin: number;
  resetsAt: string;
  capInMin: number | null;    // minutes until 100% at current burn; null if it won't cap
}
