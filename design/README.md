# SlopMaxxer: handoff for Claude Code

1. Unzip this folder into a new, empty project directory, for example `~/code/slopmaxxer/design/`.
2. Open `design/reference/index.html` in a browser to see the target. It's fully clickable.
3. Start Claude Code in the project root and paste the prompt below.

---

**Prompt for Claude Code**

> Build SlopMaxxer, a local web dashboard, from the handoff in `design/`.
>
> - Read `design/HANDOFF.md` first. Then treat `design/reference/index.html` as the visual and interaction source of truth, and `design/reference/logic.js` as the logic source of truth.
> - Stack: Vite + React + TypeScript frontend, with a small Node backend serving `/api/snapshot` in the `SlopSnapshot` shape from `design/types.ts`.
> - Port `logic.js` to `src/lib/slop.ts` with unit tests that reproduce the mock-data results:
>   - score 85, rank "pace keeper";
>   - route → codex-personal;
>   - avoid = claude-work, codex-work;
>   - bankedPts 105.
> - Use `design/reference/tokens.css` as-is. Phosphor is the default theme.
> - Start with a mock adapter that returns `design/reference/mock-data.js`, and get the UI pixel-close to the reference.
> - Then investigate real data adapters for Claude and Codex on this machine (HANDOFF.md §8). Propose an approach before implementing it.
> - Ask before adding dependencies beyond React and Vite.
