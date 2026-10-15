import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { livemapHome, real } from '../agents/runtime.js';

/** History directories are 0700 and files 0600: they hold source the UI received. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** `<home>/projects/<sha1(realpath root)>`, home resolved as `src/agents/runtime.ts` does. */
export function projectDir(root: string, home: string = livemapHome()): string {
  return path.join(home, 'projects', crypto.createHash('sha1').update(real(root)).digest('hex'));
}

export const eventsName = (runId: string): string => `events-${runId}.jsonl`;
export const snapshotsDir = (dir: string): string => path.join(dir, 'snapshots');
export const snapshotPath = (dir: string, seq: number): string => path.join(snapshotsDir(dir), `${seq}.json.gz`);
export const indexPath = (dir: string): string => path.join(dir, 'index.json');

/** The run id for a run starting at `ms`: its ISO time with `:` replaced by `-`. */
export const runIdFor = (ms: number): string => new Date(ms).toISOString().replace(/:/g, '-');

/** The run id in an events file name, or null for any other file. */
export function parseEventsName(name: string): string | null {
  const m = /^events-(.+)\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

/** The seq in a snapshot file name, or null for any other file (temp files included). */
export function parseSnapshotName(name: string): number | null {
  const m = /^(\d+)\.json\.gz$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Creates the directory (and parents) and forces it to 0700. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch { /* best effort on filesystems without modes */ }
}

/** Writes a file atomically with mode 0600 (temp file in the same directory, then rename). */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, { mode: FILE_MODE, flag: 'wx' });
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
