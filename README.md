# 🍝 SlopMaxxer

> every token unused is a token wasted

A local dashboard that finds every **Claude Code** and **Codex** login on your machine and shows
all their limits in one place: the 5-hour window, the weekly window, banked resets, and the one
thing that matters: **should you pick up the pace or slow down?**

It is not an account switcher. It only reads; it never touches your logins.

## Run it

Needs Node 20+. No dependencies.

```sh
node bin/slopmaxxer.mjs            # dashboard at http://127.0.0.1:4747 (opens your browser)
node bin/slopmaxxer.mjs status     # one-shot terminal view
node bin/slopmaxxer.mjs accounts   # which installs were found
node bin/slopmaxxer.mjs --demo     # dashboard with fake accounts showing every state
npm link                           # optional: get a global `slopmaxxer` command
```

## The dashboard

The UI is the **Phosphor** design from Claude Design (handoff in `design/`):

- **Verdict:** speed up / hold / slow down across all accounts, and how many points you'd leave on the table.
- **Next task →** the account your next task should go to. "↵ feed the slop" copies the command that starts it.
- **Avoid:** accounts that are cooked or about to cap.
- **Account rows,** sorted by priority. Each one expands to show its 5-hour and weekly meters (`╋` is the pace line,
  the dim part is where you'll land at reset), burn vs. needed rate, banked resets (Codex), a 7-day sparkline and its log lines.
- **Refill schedule:** every 5h (`○`) and weekly (`◆`) refill on one 7-day strip.
- **events.log:** status changes, 429s, refills and rank changes, kept in `~/.slopmaxxer/events.jsonl`.
- **Themes:** phosphor, tokyo, gruvbox, paper, synth and graphite.

If a live read fails (a 429, an expired token), the account keeps showing its last reading, marked as stale.
The previous dashboard is still available at `/classic`.

## How it finds accounts

Like T3 Code, it picks up whatever is installed:

- `~/.claude` and `~/.codex`
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` if set
- sibling dirs used for extra accounts: `~/.claude-work`, `~/.codex_personal`, `~/.claude2`, …
- anything listed in `~/.slopmaxxer/config.json`

The same login found in two dirs shows up once.

## How it reads limits

| Provider | Source | Fallback |
|---|---|---|
| Claude | the usage endpoint behind `/usage`, using the token Claude Code already stored | expired token → "open Claude once" |
| Codex | the usage endpoint behind `/status`, using `auth.json` | newest `rate_limits` event in `sessions/*.jsonl` |

These are the same calls the official CLIs make. They aren't public APIs, so they may change.
Tokens are **never refreshed or rewritten** by SlopMaxxer, which means it can't break your CLI logins.

## Resets

- **Refills:** every window shows a live countdown, and the refill timeline shows all of them on one 7-day axis.
- **Banked resets:** Codex sometimes grants reset credits that clear a used-up limit instantly. SlopMaxxer shows how many each Codex account has (it also shows 0, so you know it checked). Claude has no banked resets.

## The verdicts

Each window has a **pace line**: where you'd be if you spread the window evenly. SlopMaxxer compares
your usage and your recent burn rate (measured from its own history) against that line.

| | Verdict | Meaning |
|---|---|---|
| 🍝 | FEED THE SLOP | well under pace. Run more agents |
| 🚨 | USE IT OR LOSE IT | lots left and the weekly reset is under 24h away (or the 5h window is under 1h) |
| ✨ | ON PACE | carry on |
| 🧊 | SLOW DOWN | at this burn rate you hit the cap well before reset |
| 😴 | WINDOW ASLEEP | the 5h window hasn't started. Send a prompt to start the clock |
| ⏳ | WAIT FOR RESET | 5h window tapped, weekly still has room |
| 🔥 | COOKED | weekly cap hit |
| 👑 | MAXXED | 90%+ used. Respect |

**Next up** points at the account whose remaining capacity runs out soonest, so that's where your
next task should go. The **Slop-o-meter** averages usage-vs-pace across accounts (100 = on pace).

## Config (optional)

`~/.slopmaxxer/config.json`:

```json
{
  "pollSeconds": 120,
  "extraClaudeDirs": ["D:/accounts/claude-side"],
  "extraCodexDirs": [],
  "ignoreDirs": ["C:/Users/me/.claude-old"],
  "nicknames": { "claude:me@work.com": "Work Claude", "codex:me@work.com": "Work Codex" }
}
```

History used for burn rates and sparklines is kept for 8 days in `~/.slopmaxxer/history.jsonl`.

The 7-day graph also reads history that is already on disk, so it isn't empty on day one:

- **Codex:** exact. Every session log in `<CODEX_HOME>/sessions` records the limit status with a timestamp.
- **Claude:** estimated (shown with `~`). Transcripts in `<CLAUDE_CONFIG_DIR>/projects` record tokens, not the % of
  your limit, so tokens are weighted by model price and calibrated against the live weekly % of the current window.
  Usage outside Claude Code on this machine (claude.ai, other computers) isn't in the transcripts, so it shifts the estimate.
  Once SlopMaxxer has its own readings for a period, those replace the estimate.
