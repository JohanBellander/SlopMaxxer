// Finds every Claude Code / Codex install on this machine, the way T3 Code does:
// default homes, env overrides (CLAUDE_CONFIG_DIR / CODEX_HOME), any ~/.claude-* / ~/.codex-*
// sibling dirs people use for extra accounts, plus extra paths from ~/.slopmaxxer/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SLOP_HOME = process.env.SLOPMAXXER_HOME || path.join(os.homedir(), '.slopmaxxer');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SLOP_HOME, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const exists = (p) => {
  try { fs.accessSync(p); return true; } catch { return false; }
};

function isClaudeHome(dir) {
  return exists(path.join(dir, '.credentials.json'));
}
function isCodexHome(dir) {
  return exists(path.join(dir, 'auth.json'));
}

export function discoverInstalls(config = loadConfig()) {
  const home = os.homedir();
  const candidates = { claude: new Set(), codex: new Set() };

  candidates.claude.add(path.join(home, '.claude'));
  candidates.codex.add(path.join(home, '.codex'));
  if (process.env.CLAUDE_CONFIG_DIR) candidates.claude.add(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  if (process.env.CODEX_HOME) candidates.codex.add(path.resolve(process.env.CODEX_HOME));

  // Sibling dirs: ~/.claude-work, ~/.claude_personal, ~/.codex2, ...
  for (const scanRoot of [home, path.join(home, '.config')]) {
    let entries = [];
    try { entries = fs.readdirSync(scanRoot, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (/^\.?claude([-_.].+|\d+)?$/i.test(e.name)) candidates.claude.add(path.join(scanRoot, e.name));
      if (/^\.?codex([-_.].+|\d+)?$/i.test(e.name)) candidates.codex.add(path.join(scanRoot, e.name));
    }
  }

  for (const p of config.extraClaudeDirs || []) candidates.claude.add(path.resolve(p));
  for (const p of config.extraCodexDirs || []) candidates.codex.add(path.resolve(p));

  const ignored = new Set((config.ignoreDirs || []).map((p) => path.resolve(p).toLowerCase()));
  const out = [];
  for (const dir of candidates.claude) {
    if (!ignored.has(dir.toLowerCase()) && isClaudeHome(dir)) out.push({ provider: 'claude', dir });
  }
  for (const dir of candidates.codex) {
    if (!ignored.has(dir.toLowerCase()) && isCodexHome(dir)) out.push({ provider: 'codex', dir });
  }
  return out;
}
