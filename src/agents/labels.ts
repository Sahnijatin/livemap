import { realpathSync } from 'node:fs';
import { isSecretEnvPath, SECRET_NAME_ALT } from '../engine/languages.js';

const MAX_LABEL = 160;
/** Stored in place of a shell command that names a secret env file. */
export const SECRET_COMMAND = '<touches a secret file>';
/** Label of a shell command that names a secret env file. */
export const SECRET_LABEL = '$ (command touching .env)';
const PATH_KEYS = ['file_path', 'path', 'absolute_path', 'notebook_path', 'filePath', 'target_file'];

export type ToolFamily = 'read' | 'write' | 'edit' | 'shell' | 'patch' | 'search' | 'glob' | 'fetch' | 'websearch' | 'subagent' | 'notebook';
const FAMILIES: Record<ToolFamily, string[]> = {
  read: ['read', 'read_file', 'view'],
  write: ['write', 'write_file', 'create_file'],
  edit: ['edit', 'multiedit', 'replace', 'edit_file', 'str_replace'],
  shell: ['bash', 'shell', 'run_shell_command', 'exec_command'],
  patch: ['apply_patch'],
  search: ['grep', 'search_file_content'],
  glob: ['glob', 'list_directory', 'ls'],
  fetch: ['webfetch', 'web_fetch'],
  websearch: ['websearch', 'google_web_search'],
  subagent: ['task', 'agent'],
  notebook: ['notebookedit'],
};
const BY_NAME = new Map<string, ToolFamily>();
for (const [fam, names] of Object.entries(FAMILIES)) for (const n of names) BY_NAME.set(n, fam as ToolFamily);
const familyOf = (name: string): ToolFamily | undefined => BY_NAME.get(name.toLowerCase());

/** Family of a tool name (case-insensitive), or undefined when unknown. */
export const toolFamily = familyOf;

const rec = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function trunc(s: string): string {
  return s.length <= MAX_LABEL ? s : s.slice(0, MAX_LABEL - 1) + '…';
}

const posix = (p: string) => p.replace(/\\/g, '/');
const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/** Collapses `.` and `..` segments of an absolute POSIX path. */
function collapse(abs: string): string {
  const lead = abs.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length > (lead ? 0 : 1)) parts.pop(); continue; }
    parts.push(seg);
  }
  return lead + parts.join('/');
}

/** A relative path joined to an absolute cwd (when given), else unchanged. */
function anchor(p: string, cwd?: string): string {
  const path = posix(p);
  if (isAbs(path) || !cwd || !isAbs(posix(cwd))) return path;
  return collapse(`${posix(cwd).replace(/\/+$/, '')}/${path}`);
}

/**
 * An absolute path with its longest existing prefix resolved through symlinks (the rest, which
 * may not exist yet, is kept as is), or null when nothing resolves or nothing changes.
 */
function realAbs(path: string): string | null {
  const parts = path.split('/');
  for (let n = parts.length; n > 1; n--) {
    const head = parts.slice(0, n).join('/');
    let real: string;
    try { real = posix(realpathSync(head)); } catch { continue; }
    const out = [real.replace(/\/+$/, ''), ...parts.slice(n)].join('/');
    return out === path ? null : out;
  }
  return null;
}

/** Path relative to root in POSIX form, or null when it lies outside the root. Relative paths resolve against `cwd` when given. */
function relToRoot(p: string, root: string, cwd?: string): string | null {
  const anchored = anchor(p, cwd);
  // An absolute path may still hold `.` and `..` (`/p/src/../lib/a.ts`); compare it collapsed.
  const path = isAbs(anchored) ? collapse(anchored) : anchored;
  const r = posix(root).replace(/\/+$/, '');
  if (isAbs(path)) {
    const under = (abs: string) => abs !== r && abs.startsWith(r + '/');
    if (under(path)) return path.slice(r.length + 1);
    // The root is a real path; an agent working through a symlinked folder names files by the link.
    const real = realAbs(path);
    return real && under(real) ? real.slice(r.length + 1) : null;
  }
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.pop()) return null; continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function displayPath(p: string, root?: string, cwd?: string): string {
  const path = root ? anchor(p, cwd) : posix(p);
  if (!isAbs(path)) return path;
  if (root) {
    const rel = relToRoot(path, root);
    if (rel) return rel;
  }
  return path.split('/').filter(Boolean).slice(-3).join('/');
}

function inputPaths(input: unknown): string[] {
  const o = rec(input);
  const out: string[] = [];
  for (const k of PATH_KEYS) { const v = str(o[k]); if (v) out.push(v); }
  return out;
}

function commandText(input: unknown): string | undefined {
  const c = rec(input).command;
  if (Array.isArray(c)) { const s = c.filter((x) => typeof x === 'string').join(' '); return s || undefined; }
  return str(c) ?? str(rec(input).cmd);
}

/** Paths named by `*** Add/Update/Delete File:` and `*** Move to:` lines, sorted and unique. */
export function patchPaths(patch: string): string[] {
  const set = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

const TOKEN_SPLIT = /[\s'"`=;|&<>(){},]+/;

/** A shell word naming a secret env file; a glob such as `.env*` counts because it can expand to one. */
function secretToken(t: string): boolean {
  if (!t) return false;
  if (isSecretEnvPath(t)) return true;
  const b = t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1);
  return /[*?[]/.test(b) && /^\.env/i.test(b);
}

/** True when a shell command names a secret env file (or is already the redaction marker). */
function commandTouchesSecret(cmd: string): boolean {
  return cmd === SECRET_COMMAND || cmd.split(TOKEN_SPLIT).some(secretToken);
}

export function toolLabel(name: string, input: unknown, root?: string, cwd?: string): string {
  const o = rec(input);
  const fam = familyOf(name);
  const file = () => { const p = inputPaths(input)[0]; return p ? displayPath(p, root, cwd) : ''; };
  const withArg = (verb: string, arg: string | undefined) => trunc(arg ? `${verb} ${arg}` : verb);
  switch (fam) {
    case 'read': return withArg('Read', file());
    case 'write': return withArg('Write', file());
    case 'edit': return withArg('Edit', file());
    case 'notebook': return withArg('Edit notebook', file());
    case 'shell': {
      const cmd = commandText(input);
      return cmd && commandTouchesSecret(cmd) ? SECRET_LABEL : withArg('$', cmd);
    }
    case 'patch': {
      const ps = patchPaths(commandText(input) ?? '').map((p) => displayPath(p, root, cwd));
      return withArg('Patch', ps.join(', '));
    }
    case 'search': {
      const pat = str(o.pattern) ?? str(o.query);
      return withArg('Search', pat && `"${pat}"`);
    }
    case 'glob': return withArg('Find files', str(o.pattern) ?? str(o.dir_path) ?? file());
    case 'fetch': return withArg('Fetch', str(o.url));
    case 'websearch': {
      const q = str(o.query);
      return withArg('Web search', q && `"${q}"`);
    }
    case 'subagent': return withArg('Subagent:', str(o.description) ?? str(o.prompt));
    default: return trunc(name);
  }
}

export function toolPaths(name: string, input: unknown, root: string, cwd?: string): string[] {
  const fam = familyOf(name);
  const raw = fam === 'patch' ? patchPaths(commandText(input) ?? '') : inputPaths(input);
  const set = new Set<string>();
  for (const p of raw) {
    const rel = relToRoot(p, root, cwd);
    if (rel) set.add(rel);
  }
  return fam === 'patch' ? [...set].sort() : [...set];
}

/**
 * Secret-file inputs keep only their path(s); contents and edits are dropped. A shell command naming a
 * secret file becomes `{command: SECRET_COMMAND}`. Returns `input` itself when nothing is secret.
 */
export function redactSecretInput(name: string, input: unknown): unknown {
  const o = rec(input);
  if (familyOf(name) === 'patch') {
    const patch = commandText(input) ?? '';
    const ps = patchPaths(patch);
    if (!ps.some(isSecretEnvPath)) return input;
    return { command: patch.split(/\r?\n/).filter((l) => l.startsWith('*** ')).join('\n') };
  }
  const cmd = commandText(input);
  if (cmd && commandTouchesSecret(cmd)) return { command: SECRET_COMMAND };
  const paths = PATH_KEYS.filter((k) => str(o[k]));
  if (!paths.some((k) => isSecretEnvPath(o[k] as string))) return input;
  const out: Record<string, unknown> = {};
  for (const k of paths) out[k] = o[k];
  return out;
}

/** True when the tool touches a secret env file: by root-relative path, by (out-of-root) input path, or by shell command. */
export function touchesSecret(name: string, input: unknown, paths: string[]): boolean {
  return paths.some(isSecretEnvPath) || redactSecretInput(name, input) !== input;
}

// Built from the same names as isSecretEnvPath (`.env`, `.envrc`, `.npmrc`, `.netrc`, `.pypirc`), which then rules out examples.
const SECRET_REF = new RegExp(`(?:^|[\\s/\\\\'"\`(=])(\\.(?:${SECRET_NAME_ALT})(?:[._-][\\w.-]*)?)(?=[:\\s'"\`),;]|$)`, 'gim');

/** True when tool output names a secret env file (as grep, cat or diff output does), example files aside. */
export function outputMentionsSecret(text: string): boolean {
  for (const m of text.matchAll(SECRET_REF)) if (isSecretEnvPath(m[1])) return true;
  return false;
}
