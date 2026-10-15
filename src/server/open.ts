import { spawn, type SpawnOptions } from 'node:child_process';

const OPENABLE = /^http:\/\/127\.0\.0\.1:\d+\/(\?launch=[0-9a-f]+)?$/;

/** Only LiveMap's own loopback launch URL (never the token itself) is handed to a shell opener. */
export function isOpenableUrl(url: string): boolean {
  return OPENABLE.test(url);
}

export interface Opener { cmd: string; args: string[]; opts: SpawnOptions }

/**
 * The command that opens `url`: the program named by `BROWSER` when set (run with the URL as its one
 * argument), else `open` on macOS, `cmd /c start` on Windows and `xdg-open` elsewhere. A Windows
 * `.cmd` or `.bat` in `BROWSER` needs cmd to run it; the URL is a checked loopback URL, so quoting it is safe.
 */
export function openerFor(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Opener {
  const browser = env.BROWSER?.trim();
  if (browser) {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(browser)) {
      return { cmd: 'cmd', args: ['/d', '/s', '/c', `""${browser}" "${url}""`], opts: { windowsVerbatimArguments: true } };
    }
    return { cmd: browser, args: [url], opts: {} };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url], opts: {} };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], opts: { windowsVerbatimArguments: true } };
  return { cmd: 'xdg-open', args: [url], opts: {} };
}

/** Opens the URL in the default browser (or `BROWSER`). Best effort: never throws, ignores failures. */
export function openBrowser(url: string): void {
  if (!isOpenableUrl(url)) return;
  try {
    const { cmd, args, opts } = openerFor(url);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener available; the URL is printed for the user anyway
  }
}
