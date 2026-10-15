import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { livemapHome, real } from './agents/runtime.js';

/**
 * One LiveMap per project: `<LIVEMAP_HOME>/locks/<sha1(realpath root)>.lock` holds the owner's pid, a random
 * id, and its port once the server listens (`{"pid":N,"id":"…","port":P}`). The server answers
 * `GET /__livemap/lock` with that id, so a later starter can tell the holder from anything else that reuses
 * its pid or port. The holder also touches the file every `HEARTBEAT_MS`.
 * Two instances on one root would share history files and the runtime entry, so the second must not start.
 */
export function lockFile(root: string): string {
  return path.join(livemapHome(), 'locks', `${crypto.createHash('sha1').update(real(root)).digest('hex')}.lock`);
}

export const HEARTBEAT_MS = 30_000;
/** A lock not touched for this long belongs to a LiveMap that is gone (or frozen far beyond any normal pause). */
export const LOCK_STALE_MS = 3 * 60_000;
/** How long starters that found the same stale lock wait for each other (and for a dead starter's mutex). */
export const TAKEOVER_WAIT_MS = 20_000;
const PROBE_MS = 500;
/** The path a LiveMap server answers with its lock id (no token: the id is random and says nothing). */
export const LOCK_PATH = '/__livemap/lock';
const RETRY_MS = 50;
/** A takeover mutex is held for one read and unlink; one this old was left by a starter that died there. */
const MUTEX_STALE_MS = 10_000;

/** Thrown when the lock stays contended for `TAKEOVER_WAIT_MS` (another LiveMap is starting here). */
export class LockBusyError extends Error {}

interface LockState { text: string; pid: number | null; id: string | null; port: number | null; mtimeMs: number; ino: number }

function parse(text: string): { pid: number | null; id: string | null; port: number | null } {
  const t = text.trim();
  let pid: unknown = Number(t);
  let id: unknown = null;
  let port: unknown = null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown> | null;
      pid = o?.pid;
      id = o?.id ?? null;
      port = o?.port ?? null;
    } catch { pid = null; }
  }
  return {
    pid: Number.isInteger(pid) && (pid as number) > 0 ? (pid as number) : null,
    id: typeof id === 'string' && id ? id : null,
    port: Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 ? (port as number) : null,
  };
}

/** This process's lock ids, by lock file. */
const ids = new Map<string, string>();
const content = (o: { id: string; port?: number }) => `${JSON.stringify({ pid: process.pid, ...o })}\n`;

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
 * Whether the LiveMap holding lock `id` answers on `port`: `yes` when the server there names that id; `no`
 * when nothing listens, or a server answers with another id or is not a LiveMap; `silent` when a connection
 * opens but no answer comes in time (a suspended LiveMap, or a service that does not speak HTTP).
 */
function answers(port: number, id: string): Promise<'yes' | 'no' | 'silent'> {
  return new Promise(resolve => {
    let settled = false;
    const done = (r: 'yes' | 'no' | 'silent') => { if (!settled) { settled = true; req.destroy(); resolve(r); } };
    const req = http.get({ host: '127.0.0.1', port, path: LOCK_PATH, timeout: PROBE_MS }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (body.length < 1024) body += c; });
      res.on('end', () => {
        let got: unknown;
        try { got = (JSON.parse(body) as { lock?: unknown }).lock; } catch { got = undefined; }
        done(res.statusCode === 200 && got === id ? 'yes' : 'no');
      });
      res.on('error', () => done('no'));
    });
    req.on('timeout', () => done('silent'));
    req.on('error', () => done('no'));
  });
}

/**
 * Whether the lock still belongs to a running LiveMap: its pid runs and, once its port is recorded, the
 * LiveMap there answers with the lock's id, whatever the lock's age (a sleeping laptop's LiveMap answers once
 * it wakes). A crash leaves a lock whose pid or port something else may take after a reboot; neither
 * answers with the id. When nothing answers in time, or before the port is recorded, the holder's heartbeat
 * decides: recent means held (a suspended LiveMap, or one still starting), `LOCK_STALE_MS` old means gone.
 */
async function held(s: LockState): Promise<boolean> {
  if (s.pid === null || !pidRuns(s.pid)) return false;
  const fresh = Date.now() - s.mtimeMs <= LOCK_STALE_MS;
  if (s.port === null) return fresh;
  // A lock written before locks had ids: something listening on its port is all that can be checked.
  if (s.id === null) return listening(s.port);
  const a = await answers(s.port, s.id);
  return a === 'yes' || (a === 'silent' && fresh);
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
  const id = crypto.randomBytes(12).toString('hex');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content({ id }), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, file);
        ids.set(file, id);
        startHeartbeat(file);
        return { ok: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const s = readLock(file);
      if (s?.pid === process.pid) {
        // Ours already (re-entry), or left with this pid by an earlier process: adopt it with an id.
        if (s.id) ids.set(file, s.id);
        else { fs.writeFileSync(tmp, content({ id }), { mode: 0o600 }); fs.renameSync(tmp, file); ids.set(file, id); }
        startHeartbeat(file);
        return { ok: true };
      }
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
 * this LiveMap from anything else that reuses its pid or port. `held` when recorded, `lost` when another
 * process holds the lock now, `unknown` when the lock cannot be read. A failed write throws: the lock is
 * still this process's (its heartbeat goes on), it just has no port yet.
 */
export function setLockPort(root: string, port: number): 'held' | 'lost' | 'unknown' {
  const file = lockFile(root);
  let s: LockState | null;
  try { s = readLock(file); } catch { return 'unknown'; }
  const id = ids.get(file);
  if (s?.pid !== process.pid || !id) return 'lost';
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content({ id, port }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return 'held';
}

/** The id the server answers `LOCK_PATH` with, when this process holds the lock. */
export function lockId(root: string): string | undefined {
  return ids.get(lockFile(root));
}

/** Removes the lock only when this process holds it. */
export function releaseLock(root: string): void {
  const file = lockFile(root);
  clearInterval(heartbeats.get(file));
  heartbeats.delete(file);
  ids.delete(file);
  try {
    if (readLock(file)?.pid !== process.pid) return;
    fs.unlinkSync(file);
  } catch { /* already gone or unreadable */ }
}
