# SlopMaxxer: design handoff

A local web dashboard for one person who pays for several Claude and Codex subscriptions. It answers two questions at a glance:

1. **Should I speed up or slow down?** (the verdict)
2. **Which account should my next task go to?** (the route)

Everything else is detail, hidden behind expandable rows.

Voice: terse, terminal-flavoured, a little meme-y ("Feed the slop", "Cooked", "Token Graveyard"). Chosen theme: **Phosphor** (dark, green-screen, modern).

---

## 1. What's in this folder

| File | What it is |
|---|---|
| `reference/index.html` | **Working reference prototype.** Open it in a browser. This is the source of truth for layout, copy and interaction. |
| `reference/logic.js` | Pure derivation logic: statuses, verdict, routing, score, glyph meters, timeline, braille sparkline. Port it 1:1. |
| `reference/mock-data.js` | A realistic snapshot of 6 accounts plus an event log, covering all 6 statuses. |
| `reference/tokens.css` | Design tokens as CSS custom properties. Phosphor is the default; 5 alternates sit under `[data-theme]`. |
| `reference/screenshot-desktop.png` | Render at 1440px wide. Fonts fell back in the capture environment; the real fonts are JetBrains Mono and Geist. |
| `types.ts` | Data model: the `SlopSnapshot` the UI consumes, plus the derived window shape. |

---

## 2. Layout (top to bottom)

```
❯ slopmaxxer                                score 85 · pace keeper   ● synced 14:20   theme ▾
❯ slop verdict
▲ Speed up. You're leaving 105 pts on the table this week.        ← H1, Geist 60px
Next task → codex/pro personal  [↵ feed the slop]
avoid: claude/max-5x work (caps in 48m)  codex/plus work (cooked till 14:58)

┌ accounts (≈66%) ─────────────────────────────┐  ┌ event log (≈34%) ───────┐
│ codex/pro personal  [▲▲ speed up] ━━╋──── →36% wk ▾ │  │ ❯ tail -f events.log  ● │
│   (expanded details…)                        │  │ 14:20:03 INFO sync ok…  │
│ claude/pro side     [▲ speed up]  ━━━╋━── →71% wk ▸ │  │ 14:18:51 429  codex/…   │
│ …                                             │  │ …     [show 6 more]     │
│ ▸ refill schedule · next 7 days              │  └─────────────────────────┘
└───────────────────────────────────────────────┘
```

- Max content width 1240px, centered, gutter `clamp(16px, 3vw, 40px)`.
- Two columns, flex-wrap: accounts `flex: 999 1 620px`, log `flex: 1 1 340px`. On narrow screens the log stacks under the accounts.

### 2.1 Header
Wordmark `❯ slop` + `maxxer` in the accent color. On the right: score and rank name, sync status, theme picker.

### 2.2 Verdict (the most important element)
- Label: `❯ slop verdict` in muted.
- H1 in Geist 700, `clamp(36px, 5vw, 60px)`, letter-spacing −0.03em. Verdict word in its tone color; the reason in muted.
  - `▲ Speed up.` (tone `pink`) when score < 95. Reason: "You're leaving {bankedPts} pts on the table this week."
  - `▼ Slow down.` (tone `hot`) when score > 105. Reason: "You'll hit caps before the week resets."
  - `● Hold.` (tone `ok`) otherwise. Reason: "Right on pace. Perfectly balanced."
- Next-task line: "Next task →", then the slug in the provider color (800 weight, 22px), the label, and the primary button "↵ feed the slop".
- Avoid line: every cooked or slow-down account, each with its reason in its tone color.

### 2.3 Account rows (collapsed)
A full-width `<button aria-expanded>` with one row of five parts:
1. **Name:** slug (`claude/max-20x`) in the provider color, bold, then the label in muted.
2. **Action chip (15ch wide):** text from the table below, in its tone color on a 15% tint of it.
3. **Mini weekly meter:** 20 glyphs (see §4).
4. **Projection:** `→ 99% wk`. The number is `hot` if over 100, `warn` if under 90, otherwise `ok`.
5. **Chevron:** `▸` collapsed, `▾` open.

Rows are sorted by action priority (below), then by hunger (`need − burn`, highest first). The top row is expanded by default, and it is the routed account.

| status | action chip | tone | priority | rule (first match wins) |
|---|---|---|---|---|
| cooked | `✕ cooked` | red | 5 | 5h or weekly used ≥ 100 |
| slowdown | `▼ slow down` | hot | 4 | 5h projected > 100, or weekly projected > 100 |
| asleep | `◌ wake it` | idle | 2 | 5h window not active |
| useit | `▲▲ speed up` | pink | 0 | weekly projected < 60 |
| pickup | `▲ speed up` | warn | 1 | weekly projected < 90 |
| onpace | `● hold` | ok | 3 | otherwise |

### 2.4 Account row (expanded)
Separated from the row by a dashed top border. Contents in order:
1. **Advice:** a one-liner in Geist 15px (copy in `logic.js → advice`).
2. **5-hour and weekly meters:** 30 glyphs each, followed by used %, `⟳ countdown`, and a second line `╋ pace {pace}% · {note}`. The note is "→ N% at reset", "cap in 48m" (hot) or "capped · back 14:58" (red).
3. **Stat chips:** `pace ±Npt`, `burn X%/h`, `need X%/h`, `weekly refill tue 02:20`.
4. **7-day braille sparkline:** 18 chars, two rows, in the provider color, with the account email on the right.
5. **Log lines** for this account only (filtered by `accountId`).

### 2.5 Refill schedule (collapsed by default)
A text button `▸ refill schedule · next 7 days`. When opened it shows a monospace strip per account: 84 glyphs, one per 2 hours, starting at local midnight today. Day headers sit every 12 glyphs.
- `·` past
- `▎` now (in the `now` color)
- `━` rest of the current week (provider color)
- `○` 5h refill
- `◆` weekly refill (`ok` color)
- `─` next week (provider color at 40%)

### 2.6 Event log (right column)
- Header `❯ tail -f events.log` with `● live`.
- A panel on `--log-bg` showing the newest 6 lines and a "show N more" toggle.
- Each line is a grid of `8ch 5ch 1fr`: time, level, message.
- Level colors: INFO muted, WARN warn, TIP ok, 429 red (message red too), RANK hot (message hot too), CRON muted.
- Footer: a blinking block cursor and "waiting for tokens…". Respect `prefers-reduced-motion`.

---

## 3. Calculations (all in `logic.js`)

Per window (the 5h window lasts 300 min, the weekly window 10,080 min):

```
remainingH = (resetsAt − now) / 60min
pacePct    = clamp((duration − remaining) / duration × 100, 0, 100)   // "where you should be by now"
projected  = round(usedPct + burnPctPerHour × remainingH)             // where you'll land at reset
need       = (100 − usedPct) / remainingH                             // burn that lands exactly on 100%
paceDelta  = usedPct − pacePct                                        // shown as "pace −46pt"
capInMin   = used ≥ 100 ? 0 : (projected > 100 ? (100 − used) / burn × 60 : null)
```

Across accounts:
- `hunger = need − burn` (weekly).
- **Route:** the first account in sorted order that is neither cooked nor slowdown.
- **Score:** `round(mean(min(weeklyProjected, 120)))`. 100 means on pace.
- **Rank:** token graveyard 0, prompt tourist 40, vibe coder 60, pace keeper 85, slop maxxer 100, rate-limit speedrunner 110.
- **Banked reset:** an account whose weekly reset will land with ≥ 10% unused. `bankedPts` is the sum of that unused %.
- All thresholds live in `CFG` at the top of `logic.js`.

---

## 4. Glyph meter spec

`width` glyphs (30 when expanded, 20 in the row). Each glyph i covers `[i, i+1) × 100/width` %; use its midpoint.

| glyph | meaning | color |
|---|---|---|
| `━` | used | provider |
| `━` | projected (used → min(projected, 100)) | provider at 35% |
| `─` | empty | `--faint` |
| `╋` | pace marker at `floor(pacePct/100 × width)` | `--now` |
| `┄` (whole bar) | window asleep | `--faint` |

Render as `white-space: pre` spans in JetBrains Mono. Use `font-variant-ligatures: none` if your stack enables them.

---

## 5. Tokens (Phosphor)

See `reference/tokens.css`. Roles:

- **Surfaces:** `bg #050A07`, `panel #0B1410`, `panel-2 #10201A`, `log-bg #030604`, `border #1A3A2B`.
- **Text:** `txt #B8F5CF`, `muted #78B892`, `faint #1F4231` (decorative glyphs only, never body text).
- **Semantic:** `now #FFE066`, `ok #3DFF8C`, `warn #FFE066`, `hot #A98BFF`, `pink #FF6BB5`, `red #FF5C5C`, `idle #8FB8A0`.
- **Providers:** Claude `#FFB86B` (amber), Codex `#6BE3FF` (cyan).
- **Brand:** `prompt`/`accent`/`btn-bg #3DFF8C`, `btn-fg #050A07`.
- **Type:** JetBrains Mono 13px/1.6 for UI; Geist for the H1, the "Next task →" label and advice text.
- **Radii:** cards 14, chips 6, buttons 10. No shadows.
- **Tints:** `color-mix(in srgb, <tone> 15%, transparent)` for chips and `50%` for the cooked card border.

---

## 6. Interaction & accessibility
- Rows, the schedule toggle and the log toggle are real `<button>`s with `aria-expanded` (and `aria-controls` on rows).
- Keep focus on the toggled row after it re-renders. Focus ring: 2px accent.
- Touch targets are at least 40px (rows at least 60px).
- Sparklines get `role="img"` with an `aria-label`.
- Color is never the only signal: every status has a glyph and a word.
- "↵ feed the slop" copies or opens the routed account (see open question 3).
- Auto-refresh every 30–60s. Show "synced HH:MM" and turn the dot `warn` when data is stale (more than 5 min old).

---

## 7. Responsive notes (to finish in the real build)
- The two columns stack below about 980px.
- Below 480px:
  - use 16-glyph meters in expanded rows (30 glyphs overflow at 390px);
  - let the row wrap the chip, meter and projection onto a second line;
  - keep the schedule in an `overflow-x: auto` box. Check it actually scrolls, because the prototype's mobile capture rendered it blank.

---

## 8. Open questions for the build
1. **Data sources.** How to read live usage for each provider and account. Options to investigate: each CLI's local logs or state files, its built-in usage/status command, or the account usage pages. Write one adapter per provider that outputs `SlopSnapshot.accounts`. Don't hard-code an approach until it's verified on this machine.
2. **Burn rate.** Compute it locally from successive snapshots (Δused / Δt over about 2h) if the provider doesn't expose it.
3. **"Feed the slop" action.** Copy a shell alias or env switch for the routed account, or just highlight it.
4. **Event log.** Generate events from state transitions between snapshots: status changes, a 429, rank changes, a window opening, a daily digest.
5. **Stack.** Suggested: Vite + React + TypeScript, served on localhost, with a small Node backend for the adapters and snapshot history (SQLite or a JSON file).
