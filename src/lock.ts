import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { livemapHome, pidAlive, real } from './agents/runtime.js';

/**
 * One LiveMap per project: `<LIVEMAP_HOME>/locks/<sha1(realpath root)>.lock` holds the owner's pid.
 * Two instances on one root would share history files and the runtime entry, so the second must not start.
 */
export function lockFile(root: string): string {
  return path.join(livemapHome(), 'locks', `${crypto.createHash('sha1').update(real(root)).digest('hex')}.lock`);
}

function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the project lock: `{ ok: true }`, or `{ ok: false, pid }` when another live process holds it.
 * The lock appears atomically with its pid already in it (a full temp file hard-linked into place), so a
 * reader never sees it empty. A lock whose pid is dead or unreadable is stale and replaced.
 */
export function acquireLock(root: string): { ok: true } | { ok: false; pid: number } {
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
      const pid = readPid(file);
      if (pid === process.pid) return { ok: true };
      if (pid !== null && pidAlive(pid)) return { ok: false, pid };
      // Stale: re-check just before removing so a lock another starter took meanwhile survives.
      if (readPid(file) === pid) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Removes the lock only when this process holds it. */
export function releaseLock(root: string): void {
  const file = lockFile(root);
  if (readPid(file) !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
