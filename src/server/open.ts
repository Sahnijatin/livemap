import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENABLE = /^http:\/\/127\.0\.0\.1:\d+\/(\?t=[0-9a-f]+)?$/;

/** Only LiveMap's own loopback URL is ever handed to a shell opener. */
export function isOpenableUrl(url: string): boolean {
  return OPENABLE.test(url);
}

export interface BrowserCommand { cmd: string; args: string[]; options: SpawnOptions; cleanup: () => void }

/**
 * Writes a redirect page to a private temp dir so the token never appears in a process's
 * arguments, which other local users can read (`/proc/<pid>/cmdline`, `ps`).
 */
function launcherFile(url: string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-')); // created 0700
  const file = path.join(dir, 'open.html');
  // The URL is validated by OPENABLE, so it needs no HTML escaping.
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><title>LiveMap</title><a href="${url}">Open LiveMap</a>\n`;
  fs.writeFileSync(file, html, { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The opener command for this URL, or null when the URL is not LiveMap's own. Windows keeps the
 * URL as an argument: other users' process command lines are not readable there by default.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand | null {
  if (!isOpenableUrl(url)) return null;
  if (platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], options: { windowsVerbatimArguments: true }, cleanup: () => {} };
  }
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
  if (!url.includes('?t=')) return { cmd, args: [url], options: {}, cleanup: () => {} };
  const { file, cleanup } = launcherFile(url);
  return { cmd, args: [file], options: {}, cleanup };
}

/** Opens the URL in the default browser. Best effort: never throws, ignores failures. */
export function openBrowser(url: string): void {
  let launch: BrowserCommand | null = null;
  try {
    launch = browserCommand(url);
    if (!launch) return;
    // The browser may read the launcher at any point, so it is removed only when LiveMap exits.
    const { cleanup } = launch;
    process.once('exit', () => { try { cleanup(); } catch { /* best effort */ } });
    const child = spawn(launch.cmd, launch.args, { stdio: 'ignore', detached: true, ...launch.options });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener available; the URL is printed for the user anyway
  }
}
