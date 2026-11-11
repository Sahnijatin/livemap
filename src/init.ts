import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/**
 * `livemap init`: installs the hook script and adds (or removes) LiveMap hooks in the project
 * config of Claude Code, Codex and Cursor without disturbing the user's own entries.
 *
 * What init itself created in a file (the file, its `hooks` object, event lists, cursor's
 * `version`) is recorded under `<LiveMap home>/init/` so remove can restore the user's file exactly.
 */
export type AgentName = 'claude' | 'codex' | 'cursor';
export const AGENT_NAMES: AgentName[] = ['claude', 'codex', 'cursor'];

export interface InitResult { agent: AgentName; file: string; action: 'created' | 'updated' | 'unchanged' | 'skipped'; reason?: string }
export interface RemoveResult { agent: AgentName; file: string; action: 'removed' | 'unchanged' | 'deleted' | 'skipped'; reason?: string }

const SCRIPT_NAME = 'livemap-hook.mjs';
/**
 * Only the exact command init generates counts as LiveMap's: the path single-quoted (POSIX, `'`
 * written as `'\''`) or double-quoted (Windows, and every command before single quoting).
 */
const LIVEMAP_COMMAND = /^node (?:"[^"]*[/\\]livemap-hook\.mjs"|'(?:[^']|'\\'')*[/\\]livemap-hook\.mjs') (claude-code|codex|cursor) [A-Za-z]+$/;

interface AgentSpec {
  file: string;
  /** Agent name the hook script and server use. */
  hookAgent: string;
  events: string[];
  kind: 'groups' | 'flat';
  /** Build the LiveMap entry for one event. */
  entry(command: string, event: string): Record<string, unknown>;
}

/** Exported for tests. */
export const SPECS: Record<AgentName, AgentSpec> = {
  claude: {
    file: '.claude/settings.local.json',
    hookAgent: 'claude-code',
    // No PostToolUse: the transcript carries tool results, and an older init's entry is dropped on re-init.
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'],
    kind: 'groups',
    entry: (command, event) => ({
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command, timeout: 5 }],
    }),
  },
  codex: {
    file: '.codex/hooks.json',
    hookAgent: 'codex',
    events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    kind: 'groups',
    entry: command => ({ hooks: [{ type: 'command', command, timeout: 5 }] }),
  },
  cursor: {
    file: '.cursor/hooks.json',
    hookAgent: 'cursor',
    events: ['beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'preToolUse', 'postToolUse', 'beforeShellExecution', 'afterShellExecution', 'afterFileEdit', 'stop'],
    kind: 'flat',
    entry: command => ({ command }),
  },
};

const GIT_EXCLUDES = ['.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLiveMap = (v: unknown): boolean => isObj(v) && typeof v.command === 'string' && LIVEMAP_COMMAND.test(v.command);
/** A Claude/Codex group that holds at least one LiveMap hook. */
const groupHasLiveMap = (g: unknown): boolean => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isLiveMap);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The shell command an agent runs for one event. POSIX shells expand `$`, backticks and `\` inside
 * double quotes, so the path is single-quoted there. cmd.exe has no such quoting: the path is
 * double-quoted and characters cmd still interprets inside quotes are refused.
 */
export function hookCommand(hookPath: string, agent: string, event: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const bad = /["%!^&|<>]/.exec(hookPath);
    if (bad) throw new Error(`hook path must not contain ${bad[0]}: ${hookPath}`);
    return `node "${hookPath}" ${agent} ${event}`;
  }
  return `node '${hookPath.replace(/'/g, "'\\''")}' ${agent} ${event}`;
}

function livemapHome(): string {
  return process.env.LIVEMAP_HOME || path.join(os.homedir(), '.livemap');
}

/**
 * Replaces `file` atomically: writes a temp file next to the real target (symlinks are kept),
 * fsyncs it, copies the original mode and renames it over the target.
 */
export function atomicWrite(file: string, content: string | Buffer, newMode = 0o644): void {
  let target = file;
  let mode = newMode;
  try {
    target = fs.realpathSync.native(file);
    mode = fs.statSync(target).mode & 0o7777;
  } catch { /* new file (or dangling link): write at `file` */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content) : content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode); // the umask may have narrowed it
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

/** Copies the built hook script to `<home>/bin/livemap-hook.mjs` (mode 0755) and returns its absolute path. */
export function installHookScript(home: string = livemapHome()): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js has hook.mjs as a sibling; from src/ (tests, tsx) it is in ../dist.
  const source = [path.join(here, 'hook.mjs'), path.join(here, '..', 'dist', 'hook.mjs')].find(p => fs.existsSync(p));
  if (!source) throw new Error('hook script not found (build LiveMap first)');
  const dest = path.resolve(home, 'bin', SCRIPT_NAME);
  const content = fs.readFileSync(source);
  let current: Buffer | null = null;
  try { current = fs.readFileSync(dest); } catch { /* not installed yet */ }
  if (!current || !current.equals(content)) atomicWrite(dest, content, 0o755);
  fs.chmodSync(dest, 0o755);
  return dest;
}

const exists = (p: string) => fs.existsSync(p);

/** Agents whose config directory exists in the project or in the user's home. */
export function detectAgents(root: string, userHome: string = os.homedir()): AgentName[] {
  return AGENT_NAMES.filter(a => exists(path.join(root, `.${a}`)) || exists(path.join(userHome, `.${a}`)));
}

// ---------------------------------------------------------------------------------------------
// What init created, per config file.

interface Created { file: boolean; hooks: boolean; version: boolean; events: string[] }
const NOTHING: Created = { file: false, hooks: false, version: false, events: [] };

function stateFile(home: string, file: string): string {
  let real: string;
  try { real = path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)); } catch { real = path.resolve(file); }
  return path.join(home, 'init', `${crypto.createHash('sha1').update(real).digest('hex')}.json`);
}

function readState(home: string, file: string): Created | null {
  try {
    const o = JSON.parse(fs.readFileSync(stateFile(home, file), 'utf8'));
    if (!isObj(o) || !Array.isArray(o.events)) return null;
    return { file: o.file === true, hooks: o.hooks === true, version: o.version === true, events: o.events.filter((e): e is string => typeof e === 'string') };
  } catch {
    return null;
  }
}

function writeState(home: string, file: string, c: Created): void {
  atomicWrite(stateFile(home, file), `${JSON.stringify(c)}\n`, 0o600);
}

function clearState(home: string, file: string): void {
  try { fs.unlinkSync(stateFile(home, file)); } catch { /* none */ }
}

// ---------------------------------------------------------------------------------------------

type Loaded = { ok: true; value: Obj | null } | { ok: false; reason: string };

function load(file: string, kind: AgentSpec['kind']): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, reason: message(e) };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: 'not valid JSON' }; }
  if (!isObj(value)) return { ok: false, reason: 'not a JSON object' };
  if (value.hooks !== undefined && !isObj(value.hooks)) return { ok: false, reason: '"hooks" is not an object' };
  for (const [ev, list] of Object.entries((value.hooks as Obj | undefined) ?? {})) {
    if (!Array.isArray(list)) return { ok: false, reason: `"hooks.${ev}" is not an array` };
    for (const item of list) {
      if (!isObj(item)) return { ok: false, reason: `"hooks.${ev}" holds an entry that is not an object` };
      if (kind === 'groups' && !Array.isArray(item.hooks)) return { ok: false, reason: `"hooks.${ev}" holds a group whose "hooks" is not an array` };
    }
  }
  return { ok: true, value };
}

function save(file: string, value: Obj): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces the LiveMap entries in `list` with `entry`, keeping its position (or appending). */
function upsert(list: unknown[], entry: Obj, kind: AgentSpec['kind']): unknown[] {
  const out: unknown[] = [];
  let at = -1;
  for (const item of list) {
    if (kind === 'flat') {
      if (isLiveMap(item)) { if (at < 0) at = out.length; continue; }
      out.push(item);
      continue;
    }
    if (!groupHasLiveMap(item)) { out.push(item); continue; }
    if (at < 0) at = out.length;
    const g = item as Obj;
    const rest = (g.hooks as unknown[]).filter(h => !isLiveMap(h));
    if (rest.length) out.push({ ...g, hooks: rest });
  }
  out.splice(at < 0 ? out.length : at, 0, entry);
  return out;
}

function hasLiveMap(config: Obj): boolean {
  if (!isObj(config.hooks)) return false;
  return Object.values(config.hooks).some(list => (list as unknown[]).some(item => isLiveMap(item) || groupHasLiveMap(item)));
}

/** `list` without its LiveMap entries; `removed` says whether it held any. */
function withoutLiveMap(list: unknown[], kind: AgentSpec['kind']): { next: unknown[]; removed: boolean } {
  const next: unknown[] = [];
  let removed = false;
  for (const item of list) {
    if (kind === 'flat') {
      if (isLiveMap(item)) removed = true;
      else next.push(item);
      continue;
    }
    if (!groupHasLiveMap(item)) { next.push(item); continue; }
    removed = true;
    const g = item as Obj;
    const rest = (g.hooks as unknown[]).filter(h => !isLiveMap(h));
    if (rest.length) next.push({ ...g, hooks: rest });
  }
  return { next, removed };
}

/**
 * Removes LiveMap entries. Containers are pruned only when init created them (per `created`), or,
 * for files init has no record of, when the removal itself emptied them.
 */
function strip(config: Obj, kind: AgentSpec['kind'], created: Created | null): Obj {
  if (!isObj(config.hooks)) return config;
  const hooks: Obj = {};
  let touched = false;
  for (const [ev, list] of Object.entries(config.hooks)) {
    const arr = list as unknown[];
    const { next, removed } = withoutLiveMap(arr, kind);
    if (!removed) { hooks[ev] = arr; continue; }
    touched = true;
    const ours = created ? created.events.includes(ev) : true;
    if (next.length || !ours) hooks[ev] = next;
  }
  if (!touched) return config;
  const out: Obj = { ...config, hooks };
  if (Object.keys(hooks).length === 0 && (created ? created.hooks : true)) delete out.hooks;
  if (created?.version && out.version === 1) delete out.version;
  return out;
}

/** Without a record, an emptied file counts as LiveMap's (cursor's bare `version: 1` included). */
function isEmptyConfig(c: Obj, agent: AgentName): boolean {
  const keys = Object.keys(c).filter(k => !(agent === 'cursor' && k === 'version' && c.version === 1));
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'hooks' && isObj(c.hooks) && Object.keys(c.hooks).length === 0);
}

function excludeHookFiles(root: string): void {
  const gitDir = path.join(root, '.git');
  try { if (!fs.statSync(gitDir).isDirectory()) return; } catch { return; }
  const file = path.join(gitDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()));
  const add = GIT_EXCLUDES.filter(l => !have.has(l));
  if (!add.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}

function initOne(root: string, agent: AgentName, hookPath: string, home: string): InitResult {
  const spec = SPECS[agent];
  const file = path.join(root, spec.file);
  const loaded = load(file, spec.kind);
  if (!loaded.ok) return { agent, file: spec.file, action: 'skipped', reason: loaded.reason };
  const before = loaded.value;
  const prior = readState(home, file);
  // A record only describes the file it was written for: once the file holds no LiveMap entry
  // (replaced, checked out, hand-edited) the record is stale and this run starts a fresh one.
  // LiveMap entries without a record (another LiveMap home, lost record) get no record at all,
  // so remove keeps its pruning fallback instead of trusting an empty "created nothing".
  const fresh = !before || !hasLiveMap(before);
  const record = !before ? { ...NOTHING, file: true } : fresh ? { ...NOTHING } : prior;
  const created: Created = record ? { ...record, events: [...record.events] } : { ...NOTHING, events: [] };
  const next: Obj = before ? { ...before } : {};
  if (agent === 'cursor' && next.version === undefined) {
    next.version = 1;
    created.version = true;
  }
  if (!isObj(next.hooks)) created.hooks = true;
  const hooks: Obj = { ...((next.hooks as Obj | undefined) ?? {}) };
  // LiveMap entries for events it no longer uses (an older init's): pruned like remove does.
  for (const ev of Object.keys(hooks)) {
    if (spec.events.includes(ev)) continue;
    const { next: rest, removed } = withoutLiveMap(hooks[ev] as unknown[], spec.kind);
    if (!removed) continue;
    const ours = record ? created.events.includes(ev) : true;
    if (rest.length || !ours) hooks[ev] = rest;
    else {
      delete hooks[ev];
      created.events = created.events.filter(e => e !== ev);
    }
  }
  for (const ev of spec.events) {
    if (!Array.isArray(hooks[ev]) && !created.events.includes(ev)) created.events.push(ev);
    const entry = spec.entry(hookCommand(hookPath, spec.hookAgent, ev), ev);
    hooks[ev] = upsert((hooks[ev] as unknown[] | undefined) ?? [], entry, spec.kind);
  }
  next.hooks = hooks;
  if (before && isDeepStrictEqual(before, next)) return { agent, file: spec.file, action: 'unchanged' };
  // Recorded before the config changes, so a crash in between never leaves LiveMap's containers
  // unrecorded; restored if the save fails.
  if (record) writeState(home, file, created);
  try {
    save(file, next);
  } catch (e) {
    if (record) try { if (prior) writeState(home, file, prior); else clearState(home, file); } catch { /* best effort */ }
    throw e;
  }
  return { agent, file: spec.file, action: before ? 'updated' : 'created' };
}

function removeOne(root: string, agent: AgentName, home: string): RemoveResult | null {
  const spec = SPECS[agent];
  const file = path.join(root, spec.file);
  const loaded = load(file, spec.kind);
  if (!loaded.ok) return { agent, file: spec.file, action: 'skipped', reason: loaded.reason };
  if (!loaded.value) { clearState(home, file); return null; }
  const created = readState(home, file);
  const next = strip(loaded.value, spec.kind, created);
  if (next === loaded.value) {
    clearState(home, file); // no LiveMap entries: any record is stale
    return { agent, file: spec.file, action: 'unchanged' };
  }
  const empty = created ? created.file && Object.keys(next).length === 0 : isEmptyConfig(next, agent);
  if (empty) fs.unlinkSync(file);
  else save(file, next);
  clearState(home, file);
  return { agent, file: spec.file, action: empty ? 'deleted' : 'removed' };
}

export interface InitOptions {
  /** Default: detected agents. */
  agents?: AgentName[];
  hookPath: string;
  /** LiveMap home, where init records what it created. Default: LIVEMAP_HOME or ~/.livemap. */
  home?: string;
  /** Non-fatal problems (default: stderr). */
  warn?: (message: string) => void;
}

/**
 * Adds LiveMap hooks for each agent. Re-running replaces LiveMap entries in place and reports
 * 'unchanged' when nothing differs. A file that cannot be read, parsed or written is 'skipped'.
 */
export function initAgents(root: string, opts: InitOptions): InitResult[] {
  const agents = opts.agents ?? detectAgents(root);
  const home = opts.home ?? livemapHome();
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`livemap: ${m}\n`));
  const results: InitResult[] = [];
  for (const agent of agents) {
    try {
      results.push(initOne(root, agent, opts.hookPath, home));
    } catch (e) {
      results.push({ agent, file: SPECS[agent].file, action: 'skipped', reason: message(e) });
    }
  }
  if (agents.length) {
    try { excludeHookFiles(root); } catch (e) { warn(`could not update .git/info/exclude: ${message(e)}`); }
  }
  return results;
}

/** Removes LiveMap hooks from each existing agent config (default: all agents), restoring what init changed. */
export function removeAgents(root: string, opts: { agents?: AgentName[]; home?: string } = {}): RemoveResult[] {
  const home = opts.home ?? livemapHome();
  const results: RemoveResult[] = [];
  for (const agent of opts.agents ?? AGENT_NAMES) {
    try {
      const r = removeOne(root, agent, home);
      if (r) results.push(r);
    } catch (e) {
      results.push({ agent, file: SPECS[agent].file, action: 'skipped', reason: message(e) });
    }
  }
  return results;
}
