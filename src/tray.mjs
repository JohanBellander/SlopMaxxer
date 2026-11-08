// Windows tray icon: a tiny PowerShell/WinForms companion (both ship with Windows, so still
// zero dependencies) that polls /api/slop and shows the remaining allowances on click.
// Everywhere else this is a no-op, and a tray failure must never take the server down.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TRAY_SCRIPT = fileURLToPath(new URL('./tray/slopmaxxer-tray.ps1', import.meta.url));
const ICON = fileURLToPath(new URL('../public/favicon.ico', import.meta.url));

export function trayCommand({ url, enabled = true } = {}, { platform = process.platform, pid = process.pid } = {}) {
  if (platform !== 'win32' || !enabled || !url) return null;
  const base = url.replace(/\/$/, '');
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', TRAY_SCRIPT,
      '-ApiUrl', `${base}/api/slop`,
      '-DashboardUrl', base,
      '-ParentPid', String(pid),
      '-IconPath', path.resolve(ICON),
    ],
  };
}

export function startTray(opts, { platform = process.platform, pid = process.pid, spawn: spawnFn = spawn } = {}) {
  const cmd = trayCommand(opts, { platform, pid });
  if (!cmd) return null;
  try {
    const child = spawnFn(cmd.file, cmd.args, { windowsHide: true, stdio: 'ignore' });
    child.on?.('error', () => { /* powershell missing: dashboard still works */ });
    // The tray also watches our pid and exits within a couple of seconds if we die first.
    process.once('exit', () => { try { child.kill(); } catch { /* already gone */ } });
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}
