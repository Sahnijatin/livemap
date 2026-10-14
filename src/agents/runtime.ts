import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runtime discovery for hooks: one `<sha1(realpath root)>.json` per running LiveMap.
 * Uses only node: built-ins because the hook bundle inlines it.
 */
export interface RuntimeEntry { root: string; port: number; token: string; pid: number }

export function runtimeDir(): string {
  const home = process.env.LIVEMAP_HOME || path.join(os.homedir(), '.livemap');
  return path.join(home, 'run');
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const fileFor = (realRoot: string): string =>
  path.join(runtimeDir(), `${crypto.createHash('sha1').update(realRoot).digest('hex')}.json`);

/** Writes the entry atomically (0600 temp file in the same 0700 dir, then rename) and returns its path. */
export function writeRuntime(root: string, port: number, token: string): string {
  const realRoot = real(root);
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
  const file = fileFor(realRoot);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const entry: RuntimeEntry = { root: realRoot, port, token, pid: process.pid };
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return file;
}

/** Removes this process's entry; a file another LiveMap wrote for the same root is left alone. */
export function removeRuntime(root: string): void {
  const file = fileFor(real(root));
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    if (o?.pid !== process.pid) return;
    fs.unlinkSync(file);
  } catch { /* already gone or unreadable */ }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(dir: string): RuntimeEntry | null {
  let o: unknown;
  try { o = JSON.parse(fs.readFileSync(fileFor(dir), 'utf8')); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const e = o as Record<string, unknown>;
  if (typeof e.root !== 'string' || typeof e.token !== 'string' || !Number.isInteger(e.port) || !Number.isInteger(e.pid)) return null;
  if (real(e.root) !== dir || (e.pid as number) <= 0 || !alive(e.pid as number)) return null;
  return { root: e.root, port: e.port as number, token: e.token, pid: e.pid as number };
}

/** The entry for `startDir` or its nearest ancestor that has a live LiveMap, or null. */
export function findRuntime(startDir: string): RuntimeEntry | null {
  let dir = real(startDir);
  for (;;) {
    const hit = read(dir);
    if (hit) return hit;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = real(up);
  }
}
