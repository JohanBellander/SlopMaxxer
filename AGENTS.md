# SlopMaxxer

Local dashboard for Claude Code and Codex account usage and pacing.

## Stack
- Node.js 20+ with native ES modules.
- Zero runtime dependencies; use Node built-ins.
- Browser UI uses plain HTML, CSS, and JavaScript.
- Tests use the built-in Node test runner.
- No build step or formatter is configured.

## Layout
- `bin/slopmaxxer.mjs`: executable CLI.
- `src/discover.mjs`: account discovery and configuration.
- `src/providers/`: live usage reads.
- `src/collect.mjs`: polling and persistence.
- `src/backfill.mjs`: historical usage import.
- `src/snapshot.mjs`: dashboard snapshot assembly.
- `src/server.mjs`: localhost HTTP server.
- `public/`: shipped dashboard assets.
- `test/`: automated tests.
- `design/`: design references, not runtime assets.
- `docs/`: screenshots and maintenance documentation.

## Commands
- `npm start`: start dashboard and open browser.
- `npm run status`: terminal summary using real accounts.
- `npm test`: run automated tests.
- `node bin/slopmaxxer.mjs --demo --no-open`: demo server.
- `node .agents/sync-skills.mjs`: sync repository skills.
- `node .agents/sync-skills.mjs --check`: check skill parity.

## Conventions
- Keep native ESM and existing two-space indentation.
- Resolve shipped assets relative to modules, not the working directory.
- Keep runtime dependencies at zero unless explicitly justified.
- Preserve existing command names and configuration behavior.
- Use deterministic fake data for offline dashboard checks.
- Test CLI failures as well as successful invocations.

## Data and security
- Bind the server to `127.0.0.1`.
- Never rewrite or refresh provider credentials.
- Never log credential contents.
- Store user state under `~/.slopmaxxer/`.
- `SLOPMAXXER_HOME` overrides that state directory.
- Provider usage endpoints are unofficial and may change.
- Prefer demo mode when checking presentation or packaging.

## Distribution
- The npm executable is `bin/slopmaxxer.mjs`.
- Ship all runtime modules and dashboard assets together.
- Exclude tests, design references, and agent configuration from npm.
- Check the packed artifact from outside the checkout before release.
- Node.js is required on the user's machine.
- Do not publish or push unless the user requests it.
- Never merge pull requests.
- Never commit to the default branch.

## Agent setup
This repo is worked on by both Claude Code and Codex; keep them in sync.
- Rules: this file. `CLAUDE.md` only imports it — edit here.
- Skills: `.agents/skills/<name>/SKILL.md` is the source; `.claude/skills/` is a generated copy. After editing a skill run `node .agents/sync-skills.mjs` (`--check` to verify).
- Permissions: `.claude/settings.json` `permissions.allow` and `.codex/rules/project.rules` list the same commands. Change both together.
- Handoff between agents: before stopping mid-task, write `.agent/handoff.md` (gitignored): goal, done, next, how to verify.
