<div align="center">

```
 ❯ slopmaxxer
```

# SlopMaxxer

### every token unused is a token wasted

**One local dashboard for every Claude Code and Codex account on your machine.**<br>
It tells you whether to speed up or slow down, and where your next task should go.

![node](https://img.shields.io/badge/node-%E2%89%A520-3DFF8C?style=flat-square&labelColor=050A07)
![deps](https://img.shields.io/badge/dependencies-0-3DFF8C?style=flat-square&labelColor=050A07)
![local](https://img.shields.io/badge/runs-127.0.0.1%20only-6BE3FF?style=flat-square&labelColor=050A07)
![claude](https://img.shields.io/badge/Claude%20Code-supported-FFB86B?style=flat-square&labelColor=050A07)
![codex](https://img.shields.io/badge/Codex-supported-6BE3FF?style=flat-square&labelColor=050A07)
![vibe](https://img.shields.io/badge/vibe-immaculate-FF6BB5?style=flat-square&labelColor=050A07)

<img src="docs/dashboard.png" alt="SlopMaxxer dashboard in the Phosphor theme, showing the verdict, the next account to use, account rows and the event log" width="900">

</div>

---

## the problem

You pay for Claude **and** ChatGPT. Maybe a few of each: work, personal, the side-project one.
Every one of them has a 5-hour window and a weekly cap, and every one of them resets on its own schedule.

On Monday you're rate-limited on one, and on Sunday another resets with 70% unused. **That's money on the floor.**

## the fix

```sh
node bin/slopmaxxer.mjs
```

SlopMaxxer finds every login on your machine, reads the limits, and turns them into one verdict:

> ### ▲ Speed up. You're leaving 105 pts on the table this week.
> **Next task →** `codex/pro personal` &nbsp; `↵ feed the slop`

No setup. No accounts to add. No API keys. It just reads what's already there.

---

## ✨ what you get

| | |
|---|---|
| 🎯 **The verdict** | *Speed up*, *Hold* or *Slow down*, based on where every account will land at reset |
| 🧭 **Next task →** | The account your next prompt should go to: the hungriest one that isn't about to cap. One click copies the command that starts it |
| 🚫 **Avoid list** | Accounts that are cooked or about to cap, with when they come back |
| 📊 **Glyph meters** | 5-hour and weekly windows drawn in box characters. `╋` is where you *should* be, and the dim part is where you'll land |
| 🔥 **Burn vs. need** | Your current %/h against the %/h it takes to max out exactly at reset |
| 🎟️ **Banked resets** | Codex reset credits, counted |
| 📅 **Refill schedule** | Every 5h `○` and weekly `◆` refill for every account on one 7-day strip |
| 📈 **7-day history** | Braille sparkline per account, **backfilled from disk** on day one |
| 📜 **`tail -f events.log`** | Status flips, 429s, refills, rank-ups. A changelog for your slop |
| 🏆 **Ranks** | token graveyard → prompt tourist → vibe coder → pace keeper → **slop maxxer** → rate-limit speedrunner |
| 🎨 **6 themes** | phosphor (default), tokyo, gruvbox, paper, synth, graphite |

<div align="center">
<img src="docs/theme-synth.png" alt="synth theme" width="49%"> <img src="docs/theme-tokyo.png" alt="tokyo theme" width="49%">
<img src="docs/theme-gruvbox.png" alt="gruvbox theme" width="49%"> <img src="docs/theme-paper.png" alt="paper theme" width="49%">
</div>

---

## 🚀 quick start

Needs **Node 20+**. That's it. No `npm install`, there's nothing to install.

```sh
git clone https://github.com/JohanBellander/SlopMaxxer.git
cd SlopMaxxer
node bin/slopmaxxer.mjs            # dashboard → http://127.0.0.1:4747 (opens your browser)
```

| command | does |
|---|---|
| `node bin/slopmaxxer.mjs` | the dashboard |
| `node bin/slopmaxxer.mjs --demo` | the dashboard with 6 fake accounts covering every state |
| `node bin/slopmaxxer.mjs status` | one-shot terminal view, for the true terminal enjoyers |
| `node bin/slopmaxxer.mjs status --json` | the same, for scripts |
| `node bin/slopmaxxer.mjs accounts` | which logins were found, and where |
| `npm link` | get a global `slopmaxxer` command |

Flags: `--port 4747`, `--no-open`.

---

## 🔍 how it finds your accounts

Like T3 Code, it picks up whatever is installed:

- `~/.claude` and `~/.codex`
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` if set
- extra logins in sibling folders: `~/.claude-personal`, `~/.codex-work`, `~/.claude2`, …
- anything you list in `~/.slopmaxxer/config.json`

**Got more accounts?** Log each one into its own folder and it shows up on the next poll:

```powershell
# PowerShell
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-personal"; claude        # then /login
mkdir $HOME\.codex-personal; $env:CODEX_HOME = "$HOME\.codex-personal"; codex login
```

```sh
# bash / zsh
CLAUDE_CONFIG_DIR=~/.claude-personal claude
mkdir -p ~/.codex-personal && CODEX_HOME=~/.codex-personal codex login
```

The same login found in two folders shows up once. The same email in two orgs (say, two Team plans) shows up twice,
because those are different limits.

## 📡 where the numbers come from

| | live limits | 7-day history |
|---|---|---|
| **Claude** | the usage endpoint behind `/usage`, using the token Claude Code stored | transcripts in `projects/`: tokens weighted by model price, calibrated on your live weekly %. **Estimated**, shown as `~` |
| **Codex** | the usage endpoint behind `/status`, using `auth.json` | session logs in `sessions/`, which record every limit status the server sent. **Exact** |

After that, SlopMaxxer records its own readings every ~2 minutes and uses those.
If a live read fails (a 429, an expired token), the account keeps its last reading, flagged as stale.

> These are the same calls the official CLIs make. They aren't public APIs, so they can change without notice.

## 🔒 is this safe?

- **Read-only.** It never refreshes, rewrites or moves a credential, so it can't break your CLI logins.
- **Local only.** The server binds to `127.0.0.1`. Your tokens only ever go to Anthropic and OpenAI, the same as with the CLIs.
- **Not an account switcher.** It tells you where to go. You decide whether you go.
- **Zero dependencies.** Nothing in `node_modules` can go wrong, because there is no `node_modules`.

---

## 🧠 the verdicts

Each window has a **pace line**: where you'd be if you spread usage evenly. Burn rate × time left = where you'll land.

| chip | status | when |
|---|---|---|
| `▲▲ speed up` | use it or lose it | weekly lands **< 60%** at reset |
| `▲ speed up` | pick it up | weekly lands **< 90%** |
| `◌ wake it` | window asleep | the 5h clock hasn't started. One prompt starts it |
| `● hold` | on pace | right on the line. Perfectly balanced |
| `▼ slow down` | slow down | you'll cap the 5h or weekly limit before it resets |
| `✕ cooked` | cooked | at the cap. Go touch grass |

**Score** = average projected weekly % across accounts (100 = on pace).
Under 95 you get *Speed up*, over 105 you get *Slow down*, and in between you get *Hold*.
All thresholds live in `CFG` at the top of [`public/slop.js`](public/slop.js).

## ⚙️ config (optional)

`~/.slopmaxxer/config.json`:

```json
{
  "pollSeconds": 120,
  "extraClaudeDirs": ["D:/accounts/claude-side"],
  "extraCodexDirs": [],
  "ignoreDirs": ["C:/Users/me/.claude-old"],
  "nicknames": { "claude:me@work.com": "work", "codex:me@gmail.com": "personal" }
}
```

Nicknames become the row labels (`claude/team-5x work`). State lives in `~/.slopmaxxer/`:
`history.jsonl` (8 days of readings), `events.jsonl` (the log), `state.json`.

---

## 🛠️ hacking on it

```sh
npm test        # node --test, no framework
node bin/slopmaxxer.mjs --demo --port 4748
```

```
bin/slopmaxxer.mjs      CLI: serve · status · accounts
src/discover.mjs        finds installs
src/providers/          claude.mjs · codex.mjs (live reads)
src/collect.mjs         polls, dedupes, stores readings
src/backfill.mjs        history from session logs and transcripts
src/snapshot.mjs        → the SlopSnapshot the UI eats, plus the event log
src/server.mjs          127.0.0.1 server: /api/slop, /api/snapshot
public/slop.js          the brain: statuses, verdict, routing, glyph meters (shared by UI and tests)
public/index.html       the Phosphor dashboard (the old one lives at /classic)
design/                 the Claude Design handoff this UI was built from
```

<div align="center">
<img src="docs/mobile.png" alt="SlopMaxxer on a phone" width="260">

<br>

**works on your phone too, for checking your slop from bed.**

<br>

*Design by Claude Design · built with Claude Code · fuelled by tokens that would otherwise have expired*

```
▎ waiting for tokens…
```

</div>
