# SlopMaxxer

Local web dashboard (plus CLI) that finds every Claude Code and Codex login on the machine, reads each
account's 5-hour and weekly limits, and turns them into one verdict (speed up / hold / slow down) and a
"next task →" account to route work to. Runs on 127.0.0.1 only, read-only on credentials. See `README.md`
for the user-facing feature list and verdict thresholds.

## Stack
- Node ≥ 20, plain ES modules (`"type": "module"`), **zero dependencies** — no `npm install`, no build step,
  no bundler. Keep it that way: don't add packages without asking.
- Tests: built-in `node:test` + `node:assert/strict`.
- UI: static HTML/CSS/JS in `public/`, served by a tiny `node:http` server.

## Layout
```
bin/slopmaxxer.mjs      CLI: serve (default) · status [--json] · accounts; flags --port --no-open --demo
src/discover.mjs        finds installs (~/.claude*, ~/.codex*, CLAUDE_CONFIG_DIR, CODEX_HOME, ~/.slopmaxxer/config.json)
src/providers/          claude.mjs · codex.mjs — live limit reads via the CLIs' own (undocumented) usage endpoints
src/collect.mjs         polls (~120s), dedupes logins, stores readings
src/backfill.mjs        7-day history from Codex session logs (exact) and Claude transcripts (estimated)
src/snapshot.mjs        builds the SlopSnapshot the UI eats + the event log diff
src/server.mjs          127.0.0.1 server: /api/slop (index.html), /api/snapshot (classic.html + CLI), static files
src/pace.mjs            CLI-side verdicts and formatting
src/mock.mjs, demo.mjs  reference mock (6 accounts, all states) and --demo mode
public/slop.js          the brain: statuses, verdict, routing, glyph meters, CFG thresholds — shared by UI AND tests
public/index.html       Phosphor dashboard (current)   public/classic.html  old dashboard at /classic
public/tokens.css       design tokens; 6 themes via [data-theme]
design/                 Claude Design handoff: HANDOFF.md, types.ts (data model), reference/ prototype
docs/                   README screenshots
```

## Commands
| Task | Command |
|---|---|
| Tests | `npm test` (= `node --test test/`) |
| Syntax check | `node --check <file>` |
| Dashboard with fake data (safe, no real accounts) | `node bin/slopmaxxer.mjs --demo --port 4748 --no-open` |
| Dashboard with real accounts | `node bin/slopmaxxer.mjs` → http://127.0.0.1:4747 |
| Terminal view / JSON | `node bin/slopmaxxer.mjs status` / `status --json` |
| Which logins were found | `node bin/slopmaxxer.mjs accounts` |

Env: `PORT`, `SLOPMAXXER_HOME` (state dir, default `~/.slopmaxxer`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`.

## Conventions
- `public/slop.js` is pure and imported by both the browser and `test/`; keep it free of Node and DOM APIs.
  Behaviour thresholds belong in its `CFG` block, not scattered in the UI.
- `design/types.ts` is the contract for `/api/slop`; `design/reference/` is the source of truth for layout and copy.
  If you change the snapshot shape, update `types.ts`, `src/snapshot.mjs`, the UI and tests together.
- The mock in `src/mock.mjs` reproduces the handoff numbers (`test/slop.test.mjs` asserts score 85, "pace keeper",
  etc.). Changing the mock or the logic means updating those expectations deliberately, not to make tests pass.
- Voice in UI copy: terse, terminal-flavoured, a little meme-y (see design/HANDOFF.md).
- Small commits, conventional-ish subjects; README screenshots live in `docs/`.

## Gotchas
- **Never write to credential files** (`.credentials.json`, `auth.json`) or refresh tokens — read-only is a core promise.
  Tokens must only ever be sent to Anthropic/OpenAI.
- The server must keep binding to `127.0.0.1`, never `0.0.0.0`.
- Running without `--demo` reads your real logins and calls live usage endpoints; prefer `--demo` while developing.
  Real state is written to `~/.slopmaxxer/` (history.jsonl, events.jsonl, state.json) — don't commit or delete it.
- The usage endpoints aren't public APIs and can change; on failure an account keeps its last reading, flagged stale.
- Use a non-default port (e.g. 4748) for dev so you don't collide with a running instance on 4747.

## Agent setup
This repo is worked on by both Claude Code and Codex; keep them in sync.
- Rules: this file. `CLAUDE.md` only imports it — edit here.
- Skills: `.agents/skills/<name>/SKILL.md` is the source; `.claude/skills/` is a generated copy. After editing a skill run `node .agents/sync-skills.mjs` (`--check` to verify).
- Permissions: `.claude/settings.json` `permissions.allow` and `.codex/rules/project.rules` list the same commands. Change both together.
- Handoff between agents: before stopping mid-task, write `.agent/handoff.md` (gitignored): goal, done, next, how to verify.
