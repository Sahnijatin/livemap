import { lstatSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { isBinaryPath, isSecretEnvPath } from './languages.js';
import { cmp } from './paths.js';

export const DEFAULT_IGNORES: string[] = [
  '.git', 'node_modules', '.livemap', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  'target', 'vendor', '.idea', '.vscode', '.DS_Store', '*.pyc', '*.log', '.gradle', 'Pods',
  '.dart_tool', '.expo', '.vercel',
];

export const MAX_PARSE_BYTES = 1_048_576;

/** True when absolute path `p` is `root` or below it (a child named `..x` counts as inside). */
export function insideRoot(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Parent directory of a project-relative POSIX path; '' for a path at the root. */
export function parentDir(rel: string): string {
  const slash = rel.lastIndexOf('/');
  return slash <= 0 ? '' : rel.slice(0, slash);
}

/** Editor temp/backup files from atomic saves (R8); never indexed by the walk or the watcher. */
const TEMP_SUFFIX = /(\.tmp|\.swp|\.swx|~)$/;
const TEMP_PREFIX = /^(\.#|4913$)/;
export function isTempName(rel: string): boolean {
  const base = path.posix.basename(rel);
  return TEMP_SUFFIX.test(base) || TEMP_PREFIX.test(base);
}

type Ignore = ReturnType<typeof ignore>;

export const ignoreStats = { reads: 0 };

/** Matcher for project-relative paths, from createIgnore. */
export type IgnoreFn = ((rel: string, isDir: boolean) => boolean) & {
  /** Records whether a directory has a .gitignore, from a listing already in hand (no probe). */
  prime(dir: string, hasGitignore: boolean): void;
  /** Rules read so far per directory (null: none); a rebuilt matcher reuses unchanged ones. */
  readonly levels: ReadonlyMap<string, Ignore | null>;
};

/**
 * Built-in ignores plus every `.gitignore` in the tree, each scoped to its own directory as git
 * does: a deeper file's rules win, and nothing under an ignored directory can be re-included.
 * Nested files are read on first use (or skipped when `prime` said there is none) and cached for
 * the life of the matcher. `reuse` keeps a previous matcher's rules, except for `changed` dirs and
 * dirs it ignored (whose .gitignore edits went unseen).
 */
export function createIgnore(root: string, reuse?: { previous: IgnoreFn; changed: string[] }): IgnoreFn {
  const defaults = ignore().add(DEFAULT_IGNORES);
  const top = ignore().add(DEFAULT_IGNORES);
  try {
    top.add(readGitignore(root));
  } catch {
    /* no .gitignore */
  }
  const levels = new Map<string, Ignore | null>();
  if (reuse) {
    const changed = new Set(reuse.changed);
    // An ignored directory's .gitignore is not watched, so its cached rules may be stale.
    for (const [dir, ig] of reuse.previous.levels) {
      if (dir !== '' && !changed.has(dir) && !reuse.previous(dir, true)) levels.set(dir, ig);
    }
  }
  levels.set('', top);
  const level = (dir: string): Ignore | null => {
    let ig = levels.get(dir);
    if (ig === undefined) {
      try {
        ig = ignore().add(readGitignore(path.join(root, ...dir.split('/'))));
      } catch {
        ig = null;
      }
      levels.set(dir, ig);
    }
    return ig;
  };
  const dirs = new Map<string, boolean>();

  /** The rules of the directories from root down to r's parent, deepest opinion last. */
  const own = (r: string, isDir: boolean): boolean => {
    const q = (sub: string): string => (isDir ? `${sub}/` : sub);
    let ignored = false;
    let defaultHit: boolean | undefined;
    // cut is -1 for the root level, then the index of each '/' that ends an ancestor directory.
    for (let cut = -1; ; ) {
      const ig = level(cut === -1 ? '' : r.slice(0, cut));
      if (ig) {
        try {
          const t = ig.test(q(r.slice(cut + 1)));
          if (t.ignored) ignored = true;
          // Only the root .gitignore may re-include what LiveMap ignores by default
          // (node_modules, .git, dist...); a nested or vendored one may not, unless the root
          // already did.
          else if (t.unignored && (cut === -1 || !(defaultHit ??= defaults.ignores(q(r)) && top.ignores(q(r))))) ignored = false;
        } catch {
          /* a path the matcher cannot express is not ignored by it */
        }
      }
      cut = r.indexOf('/', cut + 1);
      if (cut === -1) break;
    }
    return ignored;
  };
  const check = (r: string, isDir: boolean): boolean => {
    const parent = parentDir(r);
    if (parent) {
      let p = dirs.get(parent);
      if (p === undefined) { p = check(parent, true); dirs.set(parent, p); }
      if (p) return true;
    }
    return own(r, isDir);
  };

  const matcher = (rel: string, isDir: boolean): boolean => {
    const r = rel.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!r) return false;
    if (path.isAbsolute(r) || r === '..' || r.startsWith('../')) return true;
    return check(r, isDir);
  };
  return Object.assign(matcher, {
    prime(dir: string, hasGitignore: boolean): void {
      if (!hasGitignore && !levels.has(dir)) levels.set(dir, null);
    },
    levels,
  });
}

/** A directory's .gitignore; throws when there is none. A symlinked one is not followed, as in git. */
function readGitignore(dir: string): string {
  ignoreStats.reads++;
  const file = path.join(dir, '.gitignore');
  if (lstatSync(file).isSymbolicLink()) throw new Error('symlinked .gitignore');
  return readFileSync(file, 'utf8');
}

/**
 * Every non-ignored regular file (sorted), under the root or only under the `from` directories,
 * and with `opts.dirs` every directory visited. Passing a matcher from createIgnore lets the walk tell it which
 * directories have no .gitignore.
 */
export async function walk(
  root: string,
  ignored: ((rel: string, isDir: boolean) => boolean) & { prime?: IgnoreFn['prime'] },
  limit = 25000,
  from: string[] = [''],
  opts: { dirs?: boolean } = {},
): Promise<{ files: string[]; dirs: string[]; truncated: boolean }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let truncated = false;

  // With opts.dirs, directories are still reported past the file limit (files are not).
  async function visit(dirRel: string): Promise<void> {
    if (truncated && !opts.dirs) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, ...dirRel.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    ignored.prime?.(dirRel, entries.some(e => e.name === '.gitignore'));
    for (const e of entries) {
      if (truncated && !opts.dirs) return;
      if (e.isSymbolicLink()) continue;
      const rel = (dirRel ? `${dirRel}/` : '') + e.name;
      if (e.isDirectory()) {
        if (!ignored(rel, true)) { if (opts.dirs) dirs.push(rel); await visit(rel); }
      } else if (e.isFile()) {
        if (truncated || isTempName(rel) || ignored(rel, false)) continue;
        if (files.length >= limit) { truncated = true; if (opts.dirs) continue; return; }
        files.push(rel);
      }
    }
  }

  for (const dir of from) {
    if (dir === '') { await visit(''); continue; }
    // Like any entry in the walk, a symlinked start directory is not followed.
    let isDir = false;
    try { const st = await fs.lstat(path.join(root, ...dir.split('/'))); isDir = st.isDirectory(); } catch { /* gone */ }
    if (isDir && !ignored(dir, true)) { if (opts.dirs) dirs.push(dir); await visit(dir); }
  }
  files.sort(cmp);
  return { files, dirs, truncated };
}

/** Variable names only; values (including multi-line quoted ones) are never returned. */
export function envKeys(src: string): string[] {
  const keys: string[] = [];
  let open: string | null = null;
  for (const line of src.split(/\r?\n/)) {
    let rest = line;
    if (open) {
      const end = closeIndex(line, 0, open);
      if (end < 0) continue;
      open = null;
      continue;
    }
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*/.exec(rest);
    if (!m) continue;
    keys.push(m[1]);
    rest = rest.slice(m[0].length);
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      if (closeIndex(rest, 1, q) < 0) open = q;
    }
  }
  return keys;
}

function closeIndex(line: string, from: number, q: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\' && q !== "'") { i++; continue; }
    if (line[i] === q) return i;
  }
  return -1;
}

export type ReadResult =
  | { kind: 'text'; text: string; size: number }
  | { kind: 'binary' | 'tooLarge' | 'secret'; size: number; envKeys?: string[] }
  | null;

/**
 * Reads at most MAX_PARSE_BYTES + 1 bytes so a growing file cannot be read unbounded. The buffer
 * starts one byte past the stat size (to notice growth); if the file grew, it is resized to the
 * open file's current size (at least doubling), so a file stat-ed while empty takes one resize.
 */
async function readCapped(abs: string, sizeHint: number): Promise<Buffer | null> {
  const cap = MAX_PARSE_BYTES + 1;
  let fh;
  try {
    fh = await fs.open(abs, 'r');
    let buf = Buffer.allocUnsafe(Math.min(cap, Math.max(0, sizeHint) + 1));
    let off = 0;
    for (;;) {
      if (off === buf.length) {
        if (buf.length >= cap) break;
        const now = (await fh.stat()).size;
        const bigger = Buffer.allocUnsafe(Math.min(cap, Math.max(buf.length * 2, now + 1)));
        buf.copy(bigger, 0, 0, off);
        buf = bigger;
      }
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** `realRoot` (the root's realpath, if the caller has it) saves resolving it on every read. */
export async function readForModel(root: string, rel: string, realRoot?: string): Promise<ReadResult> {
  const abs = path.resolve(root, ...rel.split('/'));
  if (abs === path.resolve(root) || !insideRoot(path.resolve(root), abs)) return null;
  let size: number;
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    // Also reject paths that pass through a symlinked directory leading outside root.
    if (!insideRoot(realRoot ?? (await fs.realpath(root)), await fs.realpath(abs))) return null;
    size = st.size;
  } catch {
    return null;
  }
  if (isSecretEnvPath(rel)) {
    if (size > MAX_PARSE_BYTES) return { kind: 'secret', size, envKeys: [] };
    const buf = await readCapped(abs, size);
    if (!buf) return null;
    if (buf.length > MAX_PARSE_BYTES) return { kind: 'secret', size: buf.length, envKeys: [] };
    return { kind: 'secret', size, envKeys: envKeys(buf.toString('utf8')) };
  }
  if (isBinaryPath(rel)) return { kind: 'binary', size };
  if (size > MAX_PARSE_BYTES) return { kind: 'tooLarge', size };
  const buf = await readCapped(abs, size);
  if (!buf) return null;
  if (buf.length > MAX_PARSE_BYTES) return { kind: 'tooLarge', size: buf.length };
  if (buf.includes(0)) return { kind: 'binary', size };
  return { kind: 'text', text: buf.toString('utf8'), size };
}
