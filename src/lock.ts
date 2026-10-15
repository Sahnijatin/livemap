import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { livemapHome, real } from './agents/runtime.js';

/**
 * One LiveMap per project: `<LIVEMAP_HOME>/locks/<sha1(realpath root)>.lock` holds the owner's pid, and its
 * port once the server listens (`{"pid":N,"port":P}`; a bare pid is the form before that).
 * Two instances on one root would share history files and the runtime entry, so the second must not start.
 */
export function lockFile(root: string): string {
  return path.join(livemapHome(), 'locks', `${crypto.createHash('sha1').update(real(root)).digest('hex')}.lock`);
}

/** How long a lock without a port counts as held by its live pid: the holder is still starting up. */
export const LOCK_GRACE_MS = 2 * 60_000;
const PROBE_MS = 300;

interface LockState { text: string; pid: number | null; port: number | null; mtimeMs: number; ino: number }

function parse(text: string): { pid: number | null; port: number | null } {
  const t = text.trim();
  let pid: unknown = Number(t);
  let port: unknown = null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown> | null;
      pid = o?.pid;
      port = o?.port ?? null;
    } catch { pid = null; }
  }
  return {
    pid: Number.isInteger(pid) && (pid as number) > 0 ? (pid as number) : null,
    port: Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 ? (port as number) : null,
  };
}

function readLock(file: string): LockState | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const st = fs.statSync(file);
    return { text, ...parse(text), mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is a running process of this user. EPERM (another user's process) counts as not running:
 * that cannot be a LiveMap holding a lock in this user's home, so the pid was reused after a crash or restart.
 */
function ownPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether something accepts TCP connections on 127.0.0.1:port within a short timeout. */
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(PROBE_MS, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Whether the lock still belongs to a running LiveMap. Its pid must be alive and ours; a pid reused by an
 * unrelated process is then told apart by the port (nothing listens there any more), or, before the holder
 * has written its port, by the lock's age.
 */
async function held(s: LockState): Promise<boolean> {
  if (s.pid === null || !ownPidAlive(s.pid)) return false;
  if (s.port !== null) return listening(s.port);
  return Date.now() - s.mtimeMs < LOCK_GRACE_MS;
}

/**
 * Removes the stale lock `stale` (null: it could not be read). Checking and then unlinking
 * would race: another starter may replace the stale lock with its own in between, and that fresh lock would
 * go. So the lock is first moved aside atomically and checked there; a lock that turns out to be someone
 * else's is linked back, which succeeds only while the slot is still empty, and the caller looks again.
 */
function takeOver(file: string, stale: LockState | null): void {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // gone already: the caller retries the link
  }
  const got = readLock(aside);
  if (got?.text !== stale?.text || got?.ino !== stale?.ino) {
    try { fs.linkSync(aside, file); } catch { /* the slot is taken again; the caller looks at that lock */ }
  }
  try { fs.unlinkSync(aside); } catch { /* already gone */ }
}

/**
 * Takes the project lock: `{ ok: true }`, or `{ ok: false, pid }` when another running LiveMap holds it.
 * The lock appears atomically with its pid already in it (a full temp file hard-linked into place), so a
 * reader never sees it empty. A lock whose holder is gone, or that is unreadable, is stale and replaced.
 */
export async function acquireLock(root: string): Promise<{ ok: true } | { ok: false; pid: number }> {
  const file = lockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return { ok: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) throw e;
      }
      const s = readLock(file);
      if (s?.pid === process.pid) return { ok: true };
      if (s && await held(s)) return { ok: false, pid: s.pid as number };
      takeOver(file, s);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Records the port this process listens on in its lock (temp file, then rename), so a later starter can tell
 * this LiveMap from an unrelated process that reuses its pid. Does nothing when this process does not hold it.
 */
export function setLockPort(root: string, port: number): void {
  const file = lockFile(root);
  if (readLock(file)?.pid !== process.pid) return;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Removes the lock only when this process holds it. */
export function releaseLock(root: string): void {
  const file = lockFile(root);
  if (readLock(file)?.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
