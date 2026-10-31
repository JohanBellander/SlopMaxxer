// The reference mock snapshot from design/reference/mock-data.js (6 accounts, every status).
// Used by the tests and by `--demo` (shifted so 'now' is the real now).
export const MOCK = {
  now: '2026-10-31T14:20:00+01:00',
  accounts: [
    {
      id: 'claude-personal', provider: 'claude', plan: 'Max 20x', planSlug: 'max-20x', label: 'personal', email: 'you@personal.dev',
      fiveHour: { active: true, usedPct: 48, resetsAt: '2026-10-31T16:35:00+01:00', burnPctPerHour: 20 },
      weekly: { usedPct: 56, resetsAt: '2026-11-03T16:20:00+01:00', burnPctPerHour: 0.58 },
      dailyPct: [8, 14, 11, 6, 9, 8, 7]
    },
    {
      id: 'claude-work', provider: 'claude', plan: 'Max 5x', planSlug: 'max-5x', label: 'work', email: 'you@work.com',
      fiveHour: { active: true, usedPct: 81, resetsAt: '2026-10-31T16:10:00+01:00', burnPctPerHour: 24 },
      weekly: { usedPct: 79, resetsAt: '2026-11-01T20:20:00+01:00', burnPctPerHour: 1.3 },
      dailyPct: [10, 12, 15, 9, 13, 11, 9]
    },
    {
      id: 'codex-personal', provider: 'codex', plan: 'Pro', planSlug: 'pro', label: 'personal', email: 'you@personal.dev',
      fiveHour: { active: true, usedPct: 12, resetsAt: '2026-10-31T17:50:00+01:00', burnPctPerHour: 5 },
      weekly: { usedPct: 18, resetsAt: '2026-11-03T02:20:00+01:00', burnPctPerHour: 0.3 },
      dailyPct: [4, 2, 0, 3, 5, 1, 3]
    },
    {
      id: 'codex-work', provider: 'codex', plan: 'Plus', planSlug: 'plus', label: 'work', email: 'you@work.com',
      fiveHour: { active: true, usedPct: 100, resetsAt: '2026-10-31T14:58:00+01:00', burnPctPerHour: 0 },
      weekly: { usedPct: 96, resetsAt: '2026-11-02T02:20:00+01:00', burnPctPerHour: 0.11 },
      dailyPct: [15, 18, 12, 16, 14, 10, 11]
    },
    {
      id: 'claude-side', provider: 'claude', plan: 'Pro', planSlug: 'pro', label: 'side', email: 'you@side.dev',
      fiveHour: { active: true, usedPct: 20, resetsAt: '2026-10-31T15:50:00+01:00', burnPctPerHour: 6 },
      weekly: { usedPct: 38, resetsAt: '2026-11-04T00:20:00+01:00', burnPctPerHour: 0.4 },
      dailyPct: [6, 5, 9, 3, 7, 4, 4]
    },
    {
      id: 'codex-side', provider: 'codex', plan: 'Plus', planSlug: 'plus', label: 'side', email: 'you@side.dev',
      fiveHour: { active: false, usedPct: 0, resetsAt: null, burnPctPerHour: 0 },
      weekly: { usedPct: 30, resetsAt: '2026-11-05T10:20:00+01:00', burnPctPerHour: 0.5 },
      dailyPct: [3, 6, 4, 8, 5, 4, 0]
    }
  ],
  events: [
    { ts: '2026-10-31T14:20:03+01:00', level: 'INFO', accountId: null, msg: 'sync ok · 6 accounts · 412ms' },
    { ts: '2026-10-31T14:18:51+01:00', level: '429', accountId: 'codex-work', msg: 'codex/plus work hit the wall. cooked till 14:58' },
    { ts: '2026-10-31T14:12:07+01:00', level: 'WARN', accountId: 'claude-work', msg: 'claude/max-5x work burning hot · 5h cap in ~47m' },
    { ts: '2026-10-31T14:05:44+01:00', level: 'TIP', accountId: 'codex-personal', msg: 'codex/pro personal is starving. feed the slop' },
    { ts: '2026-10-31T13:58:10+01:00', level: 'INFO', accountId: 'claude-personal', msg: 'claude/max-20x personal back on pace' },
    { ts: '2026-10-31T13:40:22+01:00', level: 'RANK', accountId: null, msg: 'ranked up: vibe coder → pace keeper' },
    { ts: '2026-10-31T13:31:09+01:00', level: 'WARN', accountId: 'claude-side', msg: 'claude/pro side 13pt behind the pace line' },
    { ts: '2026-10-31T13:02:55+01:00', level: 'INFO', accountId: 'claude-side', msg: '5h window opened · claude/pro side' },
    { ts: '2026-10-31T12:47:30+01:00', level: 'INFO', accountId: 'codex-side', msg: 'codex/plus side asleep · 0 prompts in 6h' },
    { ts: '2026-10-31T11:15:12+01:00', level: 'TIP', accountId: null, msg: '3 resets will land half-eaten this week' },
    { ts: '2026-10-31T09:12:44+01:00', level: 'WARN', accountId: 'claude-work', msg: 'claude/max-5x work 5h window at 80%' },
    { ts: '2026-10-31T08:31:02+01:00', level: 'INFO', accountId: null, msg: 'gm. feed the slop today' }
  ]
};

/** The mock, with every timestamp moved so the snapshot's `now` is the real now. */
export function shiftedMock(now = Date.now()) {
  const delta = now - Date.parse(MOCK.now);
  const mv = (iso) => (iso ? new Date(Date.parse(iso) + delta).toISOString() : iso);
  return {
    now: new Date(now).toISOString(),
    demo: true,
    accounts: MOCK.accounts.map((a) => ({
      ...a,
      fiveHour: { ...a.fiveHour, resetsAt: mv(a.fiveHour.resetsAt) },
      weekly: { ...a.weekly, active: true, resetsAt: mv(a.weekly.resetsAt) },
    })),
    events: MOCK.events.map((e) => ({ ...e, ts: mv(e.ts) })),
  };
}
