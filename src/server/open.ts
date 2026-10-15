import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';

const OPENABLE = /^http:\/\/127\.0\.0\.1:\d+\/(\?launch=[0-9a-f]+)?$/;

/** Only LiveMap's own loopback launch URL (never the token itself) is handed to a shell opener. */
export function isOpenableUrl(url: string): boolean {
  return OPENABLE.test(url);
}

export interface Opener { cmd: string; args: string[]; opts: SpawnOptions }

/**
 * Splits a `BROWSER` value into words. Double and single quotes group words (`"C:\\Program Files\\x.exe" --new`);
 * backslashes are kept as they are, since they are Windows path separators.
 */
export function browserWords(value: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) { words.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (has || cur) words.push(cur);
  return words;
}

/**
 * The command that opens `url`, else `open` on macOS, `cmd /c start` on Windows and `xdg-open` elsewhere.
 * `BROWSER` names it instead: a program and its arguments (`chrome --incognito`), with `%s` standing for the
 * URL (Python's convention) or the URL added last. A value that is an existing file is one program, spaces
 * and all (`C:\\Program Files\\...\\chrome.exe`). A Windows `.cmd` or `.bat` runs through cmd, every word
 * quoted; the URL is a checked loopback URL, so quoting it is safe. `BROWSER=none` opens nothing (null), as
 * create-react-app reads it.
 */
export function openerFor(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isFile): Opener | null {
  const browser = env.BROWSER?.trim();
  if (browser?.toLowerCase() === 'none') return null;
  if (browser) {
    const words = exists(browser) ? [browser] : browserWords(browser);
    if (!words.length) return null;
    const [cmd, ...rest] = words;
    const args = rest.some(w => w.includes('%s')) ? rest.map(w => w.replace(/%s/g, url)) : [...rest, url];
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
      return { cmd: 'cmd', args: ['/d', '/s', '/c', `"${[cmd, ...args].map(w => `"${w}"`).join(' ')}"`], opts: { windowsVerbatimArguments: true } };
    }
    return { cmd, args, opts: {} };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url], opts: {} };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], opts: { windowsVerbatimArguments: true } };
  return { cmd: 'xdg-open', args: [url], opts: {} };
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Opens the URL in the default browser (or `BROWSER`). Best effort: never throws, ignores failures. */
export function openBrowser(url: string): void {
  if (!isOpenableUrl(url)) return;
  try {
    const opener = openerFor(url);
    if (!opener) return;
    const { cmd, args, opts } = opener;
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener available; the URL is printed for the user anyway
  }
}
