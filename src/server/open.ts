import { spawn } from 'node:child_process';

const OPENABLE = /^http:\/\/127\.0\.0\.1:\d+\/(\?t=[0-9a-f]+)?$/;

/** Only LiveMap's own loopback URL is ever handed to a shell opener. */
export function isOpenableUrl(url: string): boolean {
  return OPENABLE.test(url);
}

/** Opens the URL in the default browser. Best effort: never throws, ignores failures. */
export function openBrowser(url: string): void {
  if (!isOpenableUrl(url)) return;
  try {
    const [cmd, args, extra] =
      process.platform === 'darwin' ? ['open', [url], {}] as const
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }] as const
      : ['xdg-open', [url], {}] as const;
    const child = spawn(cmd, [...args], { stdio: 'ignore', detached: true, ...extra });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener available; the URL is printed for the user anyway
  }
}
