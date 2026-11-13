// macOS Claude Code keeps its OAuth login in the login Keychain, not in .credentials.json.
// Read-only: we only ever run `security find-generic-password`, never add/modify/delete,
// and the secret stays in memory for the provider (same as reading the file elsewhere).
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const SECURITY = '/usr/bin/security';
const execFileAsync = promisify(execFile);

// Claude Code names the item "Claude Code-credentials", plus "-<sha256(config dir)[0:8]>"
// when CLAUDE_CONFIG_DIR is set. The default ~/.claude can be either, so try both.
export function claudeKeychainServices(dir, { home = os.homedir() } = {}) {
  const base = 'Claude Code-credentials';
  const hashed = `${base}-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
  return path.resolve(dir) === path.join(home, '.claude') ? [base, hashed] : [hashed];
}

/** True when a Keychain item exists; reads attributes only, never the secret. */
export function hasClaudeKeychainLogin(dir, { platform = process.platform, run = execFileSync, home } = {}) {
  if (platform !== 'darwin') return false;
  return claudeKeychainServices(dir, { home }).some((service) => {
    try { run(SECURITY, ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
  });
}

/** The parsed credentials JSON ({ claudeAiOauth }), or null when there is none. */
export async function readClaudeKeychainLogin(dir, { platform = process.platform, run = execFileAsync, home } = {}) {
  if (platform !== 'darwin') return null;
  // ~/.claude can have both items (logged in with and without CLAUDE_CONFIG_DIR); the one
  // Claude Code still refreshes has the latest expiry, so an abandoned login never wins.
  let best = null;
  for (const service of claudeKeychainServices(dir, { home })) {
    try {
      const { stdout } = await run(SECURITY, ['find-generic-password', '-s', service, '-w'], { timeout: 5000 });
      const login = JSON.parse(stdout);
      if (!best || (login?.claudeAiOauth?.expiresAt || 0) > (best?.claudeAiOauth?.expiresAt || 0)) best = login;
    } catch { /* no such item */ }
  }
  return best;
}
