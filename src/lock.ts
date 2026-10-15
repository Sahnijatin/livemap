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

const PROBE_MS = 300;
/** A takeover mutex older than this was left by a starter that died mid-takeover. */
const MUTEX_STALE_MS = 10_000;
const RETRY_MS = 50;
const ATTEMPTS = 40;

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

/** Whether `pid` runs. EPERM (another user's process, e.g. a LiveMap started with sudo) counts as running. */
function pidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
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
 * Whether the lock still belongs to a running LiveMap: its pid runs and, once the holder has recorded its
 * port, something still listens there (a pid reused after a crash has no LiveMap on that port). A lock with
 * no port yet counts as held while its pid runs: its holder is starting up.
 */
async function held(s: LockState): Promise<boolean> {
  if (s.pid === null || !pidRuns(s.pid)) return false;
  return s.port === null || listening(s.port);
}

/**
 * Removes the lock if it is still exactly `stale`. Starters that found the same stale lock take turns under a
 * mutex file, so none of them can remove a fresh lock another just linked in its place. Returns false when
 * another starter holds the mutex (the caller waits and looks again).
 */
function removeStale(file: string, stale: LockState | null): boolean {
  const mutex = `${file}.takeover`;
  try {
    fs.writeFileSync(mutex, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    // Left by a starter that died mid-takeover: clear it so the next attempt can proceed.
    try { if (Date.now() - fs.statSync(mutex).mtimeMs > MUTEX_STALE_MS) fs.unlinkSync(mutex); } catch { /* gone */ }
    return false;
  }
  try {
    const now = readLock(file);
    if (now && now.text === stale?.text && now.ino === stale?.ino) fs.unlinkSync(file);
    else if (now && !stale) fs.unlinkSync(file); // unreadable before, still there: stale
  } catch { /* already gone */ } finally {
    try { fs.unlinkSync(mutex); } catch { /* already gone */ }
  }
  return true;
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
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= ATTEMPTS) throw e;
      }
      const s = readLock(file);
      if (s?.pid === process.pid) return { ok: true };
      if (s && await held(s)) return { ok: false, pid: s.pid as number };
      if (!removeStale(file, s)) await new Promise(r => setTimeout(r, RETRY_MS));
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Records the port this process listens on in its lock (temp file, then rename), so a later starter can tell
 * this LiveMap from an unrelated process that reuses its pid. Returns false, writing nothing, when this
 * process no longer holds the lock.
 */
export function setLockPort(root: string, port: number): boolean {
  const file = lockFile(root);
  if (readLock(file)?.pid !== process.pid) return false;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return true;
}

/** Removes the lock only when this process holds it. */
export function releaseLock(root: string): void {
  const file = lockFile(root);
  if (readLock(file)?.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
