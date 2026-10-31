# SlopMaxxer

Local web dashboard (plus CLI) that finds every Claude Code and Codex login on the machine, reads each
account's applicable limits, and explains remaining capacity, upcoming resets, and a
"next task →" account to route work to. Runs on 127.0.0.1 only, read-only on credentials. See `README.md`
for the user-facing feature list and guidance rules.

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
src/collect.mjs         polls (on demand, ≥120s apart, only while a dashboard is visible), dedupes logins, stores readings
src/backfill.mjs        7-day history from Codex session logs (exact) and Claude transcripts (estimated)
src/snapshot.mjs        builds the SlopSnapshot the UI eats + the event log diff
src/server.mjs          127.0.0.1 server: /api/slop (index.html), /api/snapshot (classic.html + CLI), static files
src/pace.mjs            raw-provider compatibility adapter (uses shared guidance)
src/history.mjs         observed rates, weekly outlook coverage, completed-window bounds
src/mock.mjs, demo.mjs  reference mock (6 accounts, all states) and --demo mode
public/guidance.js      pure decisions and messages shared by dashboard, CLI and events
public/slop.js          glyph meters, timeline and sparkline display helpers
public/index.html       dashboard; /classic also serves it to avoid obsolete verdict rules
public/tokens.css       design tokens; 6 themes via [data-theme]
design/                 Claude Design handoff: HANDOFF.md, types.ts (data model), reference/ prototype
docs/                   README screenshots
```

## Commands
| Task | Command |
|---|---|
| Tests | `npm test` (= `node --test test/`) |
| Installed package smoke test | `npm run test:package` |
| Syntax check | `node --check <file>` |
| Dashboard with fake data (safe, no real accounts) | `node bin/slopmaxxer.mjs --demo --port 4748 --no-open` |
| Dashboard with real accounts | `node bin/slopmaxxer.mjs` → http://127.0.0.1:4747 |
| Terminal view / JSON | `node bin/slopmaxxer.mjs status` / `status --json` |
| Which logins were found | `node bin/slopmaxxer.mjs accounts` |

Env: `PORT`, `SLOPMAXXER_HOME` (state dir, default `~/.slopmaxxer`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`.

## Conventions
- `public/guidance.js` and `public/slop.js` are pure; keep them free of Node and DOM APIs.
  Decision thresholds belong in `guidance.js` CFG, not in a second CLI or UI implementation.
- `design/types.ts` is the contract for `/api/slop`; `design/reference/` is the source of truth for layout and copy.
  If you change the snapshot shape, update `types.ts`, `src/snapshot.mjs`, the UI and tests together.
- The design reference preserves the original prototype. Its average score/ranks are retired.
  `test/guidance.test.mjs` covers availability, freshness, scope, forecasts and multi-account routing.
  Never make short-term bursts alone disqualify an account with remaining capacity.
  Never report exact reset utilization when only a pre-reset lower-bound reading exists.
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

## Distribution
- The npm executable is `bin/slopmaxxer.mjs`; resolve assets relative to modules, not the working directory.
- The package allowlist ships `bin/`, `src/`, and `public/` plus npm's automatic metadata and README.
- `npm run test:package` checks the packed, installed command and demo dashboard outside the checkout.
- See `docs/releasing.md` when publishing a release; publish only when requested.

## Agent setup
This repo is worked on by both Claude Code and Codex; keep them in sync.
- Rules: this file. `CLAUDE.md` only imports it — edit here.
- Skills: `.agents/skills/<name>/SKILL.md` is the source; `.claude/skills/` is a generated copy. After editing a skill run `node .agents/sync-skills.mjs` (`--check` to verify).
- Permissions: `.claude/settings.json` `permissions.allow` and `.codex/rules/project.rules` list the same commands. Change both together.
- Handoff between agents: before stopping mid-task, write `.agent/handoff.md` (gitignored): goal, done, next, how to verify.
