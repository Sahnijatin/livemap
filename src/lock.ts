import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { livemapHome, real } from './agents/runtime.js';

/**
 * One LiveMap per project: `<LIVEMAP_HOME>/locks/<sha1(realpath root)>.lock` holds the owner's pid, and its
 * port once the server listens (`{"pid":N,"port":P}`; a bare pid is the form before that). The holder
 * touches the file every `HEARTBEAT_MS`, so a lock left by a crash goes stale even when its pid is reused.
 * Two instances on one root would share history files and the runtime entry, so the second must not start.
 */
export function lockFile(root: string): string {
  return path.join(livemapHome(), 'locks', `${crypto.createHash('sha1').update(real(root)).digest('hex')}.lock`);
}

export const HEARTBEAT_MS = 30_000;
/** A lock not touched for this long belongs to a LiveMap that is gone (or frozen far beyond any normal pause). */
export const LOCK_STALE_MS = 3 * 60_000;
/** How long starters that found the same stale lock wait for each other before giving up. */
export const TAKEOVER_WAIT_MS = 15_000;
const PROBE_MS = 300;
const RETRY_MS = 50;
/** A takeover mutex is held for one read and unlink; one this old was left by a starter that died there. */
const MUTEX_STALE_MS = 5_000;

/** Thrown when the lock stays contended for `TAKEOVER_WAIT_MS` (another LiveMap is starting here). */
export class LockBusyError extends Error {}

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

/** The lock, null when there is none (ENOENT); other read errors are thrown. */
function readLock(file: string): LockState | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const st = fs.statSync(file);
    return { text, ...parse(text), mtimeMs: st.mtimeMs, ino: st.ino };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
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
 * Whether the lock still belongs to a running LiveMap: its pid runs and, once its port is recorded,
 * something listens there (whatever the lock's age: a suspended or sleeping LiveMap misses heartbeats but
 * keeps its port). Before the port is recorded the holder's heartbeat must be recent, so a lock left by a
 * crash at start-up goes stale within `LOCK_STALE_MS` even when its pid is reused.
 */
async function held(s: LockState): Promise<boolean> {
  if (s.pid === null || !pidRuns(s.pid)) return false;
  if (s.port !== null) return listening(s.port);
  return Date.now() - s.mtimeMs <= LOCK_STALE_MS;
}

/**
 * Takes the takeover mutex (`<lock>.takeover`, holding the taker's pid). It is held only around one read and
 * unlink, so one whose pid is gone, or older than `MUTEX_STALE_MS` (its pid reused after a crash), was left
 * by a starter that died there: it is moved aside, checked there and removed, and a fresh mutex moved aside
 * by mistake is put back while the slot is still empty.
 */
function takeMutex(mutex: string): boolean {
  try {
    fs.writeFileSync(mutex, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let owner: number | null;
  let age: number;
  try {
    owner = parse(fs.readFileSync(mutex, 'utf8')).pid;
    age = Date.now() - fs.statSync(mutex).mtimeMs;
  } catch { return false; }
  if (owner !== null && pidRuns(owner) && age <= MUTEX_STALE_MS) return false;
  const aside = `${mutex}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(mutex, aside); } catch { return false; }
  let moved: number | null = null;
  try { moved = parse(fs.readFileSync(aside, 'utf8')).pid; } catch { /* unreadable: treat as the dead one */ }
  if (moved !== null && moved !== owner) {
    try { fs.linkSync(aside, mutex); } catch { /* the slot is taken again */ }
  }
  try { fs.unlinkSync(aside); } catch { /* already gone */ }
  return false;
}

/**
 * Removes the lock if it is still exactly `stale`. Starters that found the same stale lock take turns under
 * the mutex, so none can remove a fresh lock another just linked in its place. Returns false when another
 * starter holds the mutex (the caller waits and looks again).
 */
function removeStale(file: string, stale: LockState): boolean {
  const mutex = `${file}.takeover`;
  if (!takeMutex(mutex)) return false;
  try {
    const now = readLock(file);
    if (now && now.text === stale.text && now.ino === stale.ino && now.mtimeMs === stale.mtimeMs) fs.unlinkSync(file);
  } finally {
    try { fs.unlinkSync(mutex); } catch { /* already gone */ }
  }
  return true;
}

/** Heartbeat timers by lock file, so a process may hold locks on several roots (tests, embedders). */
const heartbeats = new Map<string, NodeJS.Timeout>();

/**
 * Takes the project lock: `{ ok: true }`, or `{ ok: false, pid }` when another running LiveMap holds it.
 * The lock appears atomically with its pid already in it (a full temp file hard-linked into place), so a
 * reader never sees it empty. A lock whose holder is gone is stale and replaced. Throws `LockBusyError` when
 * the lock stays contended, and the filesystem's error when the lock cannot be written at all.
 */
export async function acquireLock(root: string): Promise<{ ok: true } | { ok: false; pid: number }> {
  const file = lockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, file);
        startHeartbeat(file);
        return { ok: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const s = readLock(file);
      if (s?.pid === process.pid) { startHeartbeat(file); return { ok: true }; }
      if (s && await held(s)) return { ok: false, pid: s.pid as number };
      // Gone meanwhile (s === null): link again at once. Stale: remove it, or wait for whoever is.
      if (s && !removeStale(file, s)) {
        if (Date.now() > deadline) throw new LockBusyError('another LiveMap is starting for this project');
        await new Promise(r => setTimeout(r, RETRY_MS));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Touches the lock while this process holds it, so it never looks abandoned. */
function startHeartbeat(file: string): void {
  clearInterval(heartbeats.get(file));
  const heartbeat = setInterval(() => {
    try {
      if (readLock(file)?.pid === process.pid) {
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
    } catch { /* retried at the next beat */ }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  heartbeats.set(file, heartbeat);
}

/**
 * Records the port this process listens on in its lock (temp file, then rename), so a later starter can tell
 * this LiveMap from an unrelated process that reuses its pid. Returns false, writing nothing, when this
 * process no longer holds the lock. Throws when the lock cannot be read or written, so ownership is unknown.
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
  clearInterval(heartbeats.get(file));
  heartbeats.delete(file);
  try {
    if (readLock(file)?.pid !== process.pid) return;
    fs.unlinkSync(file);
  } catch { /* already gone or unreadable */ }
}
