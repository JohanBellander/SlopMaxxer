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
