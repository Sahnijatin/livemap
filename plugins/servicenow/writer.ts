/**
 * Writes the mirror to disk under `<project>/.livemap/sn/`: folders are created readable only by the user
 * (0700; Windows uses the profile's permissions), files are written atomically and only when they change,
 * and files a previous pull wrote that this pull did not are removed (a renamed record moves).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from './mirror.js';

export const SN_DIR = path.join('.livemap', 'sn');
/** Files next to the mirror that LiveMap's own watcher must not index. */
const LOCAL_IGNORE = '# LiveMap ServiceNow state, not part of the mirror\n*.manifest.json\n*.history.json\n*.state.json\nstate.json\n';

export const snRoot = (projectDir: string): string => path.join(projectDir, SN_DIR);
export const manifestPath = (root: string, scope: string): string => path.join(root, `${scope}.manifest.json`);
export const historyPath = (root: string, scope: string): string => path.join(root, `${scope}.history.json`);

export interface StoredManifest extends Manifest { files: string[] }

export function readManifest(root: string, scope: string): StoredManifest | null {
  try { return JSON.parse(fs.readFileSync(manifestPath(root, scope), 'utf8')) as StoredManifest; } catch { return null; }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows: the profile's permissions apply */ }
}

/** Writes `text` to `file` through a temp file in the same folder, unless the file already holds it. */
function writeIfChanged(file: string, text: string): boolean {
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch { /* new file */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

export interface WriteResult { written: number; unchanged: number; removed: number; root: string }

/** Writes the mirror's files (paths relative to the mirror root) and its manifest. */
export function writeMirror(root: string, files: Map<string, string>, manifest: Manifest): WriteResult {
  const ns = manifest.scope.scope;
  if (path.basename(path.dirname(root)) === '.livemap') mkdirPrivate(path.dirname(root));
  mkdirPrivate(root);
  writeIfChanged(path.join(root, '.gitignore'), LOCAL_IGNORE);
  const prev = readManifest(root, ns);
  // The manifest first: the watcher reports a file's change as soon as it lands, and the record resolver
  // must already see that record's last change (who, when, which update set) by then. It lists the old files
  // as well as the new until the old ones are gone, so a crash in between leaves none of them untracked.
  const stored: StoredManifest = { ...manifest, files: [...files.keys()].sort() };
  const both = [...new Set([...stored.files, ...(prev?.files ?? [])])].sort();
  writeIfChanged(manifestPath(root, ns), `${JSON.stringify({ ...stored, files: both }, null, 2)}\n`);
  let written = 0;
  let unchanged = 0;
  const dirs = new Set<string>();
  for (const [rel, text] of files) {
    const abs = path.join(root, ...rel.split('/'));
    const dir = path.dirname(abs);
    if (!dirs.has(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); dirs.add(dir); }
    if (writeIfChanged(abs, text)) written++; else unchanged++;
  }
  let removed = 0;
  for (const rel of prev?.files ?? []) {
    if (files.has(rel) || !rel.startsWith(`${ns}/`)) continue;
    try { fs.unlinkSync(path.join(root, ...rel.split('/'))); removed++; } catch { /* already gone */ }
    pruneEmpty(root, path.dirname(path.join(root, ...rel.split('/'))));
  }
  if (both.length !== stored.files.length) writeIfChanged(manifestPath(root, ns), `${JSON.stringify(stored, null, 2)}\n`);
  return { written, unchanged, removed, root };
}

/** Removes empty folders from `dir` up to (not including) `root`. */
function pruneEmpty(root: string, dir: string): void {
  for (let d = dir; d.length > root.length && d.startsWith(root); d = path.dirname(d)) {
    try { fs.rmdirSync(d); } catch { return; }
  }
}

/** The git work tree `dir` lies in, or null: the nearest folder upwards with a `.git` entry. */
export function gitRoot(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Keeps the mirror out of git: when `projectDir` is inside a git work tree and its `.gitignore` does not
 * already list `.livemap`, appends `.livemap/`. Outside a git repo nothing is touched.
 */
export function ensureGitignored(projectDir: string): 'added' | 'present' | 'not-a-repo' {
  if (!gitRoot(projectDir)) return 'not-a-repo';
  const file = path.join(projectDir, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (text.split(/\r?\n/).some(l => /^\/?\.livemap\/?(\*\*)?$/.test(l.trim()))) return 'present';
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.livemap/\n`);
  return 'added';
}

/** Writes a scope's imported history (see history.ts) next to its manifest; false when it was unchanged. */
export function writeHistory(root: string, scope: string, history: unknown): boolean {
  mkdirPrivate(root);
  writeIfChanged(path.join(root, '.gitignore'), LOCAL_IGNORE);
  return writeIfChanged(historyPath(root, scope), `${JSON.stringify(history, null, 2)}\n`);
}

export function readHistory<T>(root: string, scope: string): T | null {
  try { return JSON.parse(fs.readFileSync(historyPath(root, scope), 'utf8')) as T; } catch { return null; }
}

/**
 * The live poller's state, kept across runs so a restart catches up instead of re-reading everything:
 * one cursor per source (`YYYY-MM-DD HH:MM:SS`, instance time) and the clock skew it learned.
 */
export interface PollState {
  version: 1;
  scope: string;
  cursors: { updateXml?: string; metadata?: string; deleted?: string };
  /** sys_ids already applied at each cursor's second, so a row in the same second is not applied twice. */
  seen?: { updateXml?: string[]; metadata?: string[]; deleted?: string[] };
  skewMs?: number;
}
export const statePath = (root: string, scope: string): string => path.join(root, `${scope}.state.json`);

/**
 * The poller's state for `scope`, or null when there is none (or it is another scope's). A `state.json` from an
 * earlier build is taken over once (its cursors and skew) and then removed.
 */
export function readPollState(root: string, scope: string): PollState | null {
  const read = (file: string): PollState | null => {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8')) as PollState;
      return s.version === 1 && s.scope === scope ? s : null;
    } catch { return null; }
  };
  const current = read(statePath(root, scope));
  if (current) return current;
  const legacy = path.join(root, 'state.json');
  const old = read(legacy);
  if (!old) return null;
  const moved: PollState = { version: 1, scope, cursors: old.cursors ?? {}, ...(old.seen ? { seen: old.seen } : {}), ...(old.skewMs !== undefined ? { skewMs: old.skewMs } : {}) };
  writePollState(root, moved);
  try { fs.unlinkSync(legacy); } catch { /* already gone */ }
  return moved;
}

export function writePollState(root: string, state: PollState): void {
  mkdirPrivate(root);
  writeIfChanged(statePath(root, state.scope), `${JSON.stringify(state, null, 2)}\n`);
}
