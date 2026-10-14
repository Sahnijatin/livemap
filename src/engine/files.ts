import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { isBinaryPath, isSecretEnvPath } from './languages.js';

export const DEFAULT_IGNORES: string[] = [
  '.git', 'node_modules', '.livemap', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  'target', 'vendor', '.idea', '.vscode', '.DS_Store', '*.pyc', '*.log', '.gradle', 'Pods',
  '.dart_tool', '.expo', '.vercel',
];

export const MAX_PARSE_BYTES = 1_048_576;

/** Editor temp/backup files from atomic saves (R8); never indexed by the walk or the watcher. */
const TEMP_SUFFIX = /(\.tmp|\.swp|\.swx|~)$/;
const TEMP_PREFIX = /^(\.#|4913$)/;
export function isTempName(rel: string): boolean {
  const base = path.posix.basename(rel);
  return TEMP_SUFFIX.test(base) || TEMP_PREFIX.test(base);
}

type Ignore = ReturnType<typeof ignore>;

/**
 * Built-in ignores plus every `.gitignore` in the tree, each scoped to its own directory as git
 * does: a deeper file's rules win, and nothing under an ignored directory can be re-included.
 * Nested files are read on first use and cached for the life of the matcher.
 */
export function createIgnore(root: string): (rel: string, isDir: boolean) => boolean {
  const top = ignore().add(DEFAULT_IGNORES);
  try {
    top.add(readGitignore(root));
  } catch {
    /* no .gitignore */
  }
  const levels = new Map<string, Ignore | null>([['', top]]);
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

  /** The rules of the directories from root down to rel's parent, deepest opinion last. */
  const own = (r: string, isDir: boolean): boolean => {
    const segs = r.split('/');
    let ignored = false;
    for (let i = 0; i < segs.length; i++) {
      const base = segs.slice(0, i).join('/');
      const ig = level(base);
      if (!ig) continue;
      const sub = segs.slice(i).join('/');
      try {
        const t = ig.test(isDir ? `${sub}/` : sub);
        if (t.ignored) ignored = true;
        else if (t.unignored) ignored = false;
      } catch {
        /* a path the matcher cannot express is not ignored by it */
      }
    }
    return ignored;
  };
  const check = (r: string, isDir: boolean): boolean => {
    const slash = r.lastIndexOf('/');
    if (slash > 0) {
      const parent = r.slice(0, slash);
      let p = dirs.get(parent);
      if (p === undefined) { p = check(parent, true); dirs.set(parent, p); }
      if (p) return true;
    }
    return own(r, isDir);
  };

  return (rel, isDir) => {
    const r = rel.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!r) return false;
    if (path.isAbsolute(r) || r === '..' || r.startsWith('../')) return true;
    return check(r, isDir);
  };
}

function readGitignore(dir: string): string {
  return readFileSync(path.join(dir, '.gitignore'), 'utf8');
}

export async function walk(
  root: string,
  ignored: (rel: string, isDir: boolean) => boolean,
  limit = 25000,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  async function visit(dirRel: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, ...dirRel.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue;
      const rel = (dirRel ? `${dirRel}/` : '') + e.name;
      if (e.isDirectory()) {
        if (!ignored(rel, true)) await visit(rel);
      } else if (e.isFile()) {
        if (isTempName(rel) || ignored(rel, false)) continue;
        if (files.length >= limit) { truncated = true; return; }
        files.push(rel);
      }
    }
  }

  await visit('');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, truncated };
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

/** Reads at most MAX_PARSE_BYTES + 1 bytes so a growing file cannot be read unbounded. */
async function readCapped(abs: string): Promise<Buffer | null> {
  let fh;
  try {
    fh = await fs.open(abs, 'r');
    const buf = Buffer.alloc(MAX_PARSE_BYTES + 1);
    let off = 0;
    while (off < buf.length) {
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

export async function readForModel(root: string, rel: string): Promise<ReadResult> {
  const abs = path.resolve(root, ...rel.split('/'));
  const outside = path.relative(path.resolve(root), abs);
  if (!outside || outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) return null;
  let size: number;
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    // Also reject paths that pass through a symlinked directory leading outside root.
    const realRoot = await fs.realpath(root);
    const realRel = path.relative(realRoot, await fs.realpath(abs));
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    size = st.size;
  } catch {
    return null;
  }
  if (isSecretEnvPath(rel)) {
    if (size > MAX_PARSE_BYTES) return { kind: 'secret', size, envKeys: [] };
    const buf = await readCapped(abs);
    if (!buf) return null;
    if (buf.length > MAX_PARSE_BYTES) return { kind: 'secret', size: buf.length, envKeys: [] };
    return { kind: 'secret', size, envKeys: envKeys(buf.toString('utf8')) };
  }
  if (isBinaryPath(rel)) return { kind: 'binary', size };
  if (size > MAX_PARSE_BYTES) return { kind: 'tooLarge', size };
  const buf = await readCapped(abs);
  if (!buf) return null;
  if (buf.length > MAX_PARSE_BYTES) return { kind: 'tooLarge', size: buf.length };
  if (buf.includes(0)) return { kind: 'binary', size };
  return { kind: 'text', text: buf.toString('utf8'), size };
}
