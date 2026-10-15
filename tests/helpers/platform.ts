import fs from 'node:fs';
import { expect } from 'vitest';

export const IS_WIN = process.platform === 'win32';

/**
 * Checks a file's POSIX permission bits. Windows has none (stat reports 0o666, or 0o444 when read-only)
 * and per-user folders carry the protection there, so the check runs on macOS and Linux only.
 */
export function expectMode(p: string, mode: number): void {
  if (!IS_WIN) expect(fs.statSync(p).mode & 0o777).toBe(mode);
}

/** An env whose home directory is `dir` on every platform (`os.homedir()` reads USERPROFILE on Windows). */
export function withHome(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return { ...env, HOME: dir, USERPROFILE: dir };
}

/**
 * The exit of a LiveMap a test stopped with SIGINT or SIGTERM. On POSIX it shuts down cleanly (code 0).
 * On Windows `child.kill` terminates the process outright: no signal reaches LiveMap's handler (a real
 * Ctrl+C in a console does), so the test can only check that it stopped.
 */
export function expectStopped(exit: { code: number | null; signal: NodeJS.Signals | null } | null): void {
  expect(exit).not.toBeNull();
  if (!IS_WIN) expect(exit).toEqual({ code: 0, signal: null });
}

/** Errors Windows gives while another process still holds a file or directory. */
const HELD = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/**
 * Removes a temp tree. On Windows a process the test killed can leave a child (a git command) that still
 * holds the tree as its working directory, and nothing can delete it until that child exits. So a held
 * tree is retried every 200 ms for up to 8 s. Node's own maxRetries did not retry this on Windows CI.
 */
export function rmTree(dir: string): void {
  const end = Date.now() + 8000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!HELD.has(code) || Date.now() > end) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
