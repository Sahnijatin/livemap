/**
 * Tool classifier shared by the engine and the UI (pure: no Node built-ins).
 *
 * A tool call is classified by its base name: MCP prefixes (`mcp__<server>__`, SkyForge's
 * `nexus_<sessionID>_`) are stripped and gateway calls (`tool_execute({tool, args})`) are unwrapped
 * to their inner tool. A registry of rules then says whether the call reads or writes, its family
 * for built-in agent tools, and which records it targets.
 */

export type ToolFamily = 'read' | 'write' | 'edit' | 'shell' | 'patch' | 'search' | 'glob' | 'fetch' | 'websearch' | 'subagent' | 'notebook';
export type ToolAccess = 'read' | 'write' | 'other';

/** A ServiceNow (or other non-file) record a tool call names. `instance` is '' when the call does not say. */
export interface RecordTarget { kind: 'record'; instance: string; table: string; sysId?: string; name?: string }
export interface FileTarget { kind: 'file'; path: string }
export type ToolTarget = FileTarget | RecordTarget;

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Built-in agent tools by family (names are matched case-insensitively). */
export const FAMILIES: Record<ToolFamily, string[]> = {
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
const WRITE_FAMILIES = new Set<ToolFamily>(['write', 'edit', 'patch', 'notebook', 'shell']);
const READ_FAMILIES = new Set<ToolFamily>(['read', 'search', 'glob', 'fetch', 'websearch']);
const BY_NAME = new Map<string, ToolFamily>();
for (const [fam, names] of Object.entries(FAMILIES)) for (const n of names) BY_NAME.set(n, fam as ToolFamily);

/** Family of a built-in tool name (case-insensitive), or undefined for MCP and unknown tools. */
export const familyOf = (name: string): ToolFamily | undefined => BY_NAME.get(name.toLowerCase());

const MCP_PREFIX = /^mcp__.+?__(?=.)/;
const NEXUS_PREFIX = /^nexus_ses_[A-Za-z0-9]+_(?=.)/;
/** Gateway tools whose real tool is named by an inner `tool` arg. */
const GATEWAYS = new Set(['tool_execute']);

/** The tool name without MCP or SkyForge session prefixes: `nexus_ses_ab12_tool_execute` gives `tool_execute`. */
export function baseToolName(name: string): string {
  return name.replace(MCP_PREFIX, '').replace(NEXUS_PREFIX, '');
}

/** The MCP server a prefixed name came from (`mcp__github__x` gives `github`, `nexus_ses_..._x` gives `nexus`). */
export function toolServer(name: string): string | undefined {
  const m = /^mcp__(.+?)__./.exec(name);
  if (m) return m[1];
  return NEXUS_PREFIX.test(name) ? 'nexus' : undefined;
}

/** `{tool, args}` of a gateway call with its inner tool, else the call itself. */
export function unwrapTool(name: string, input: unknown): { name: string; inner?: string; args: unknown } {
  const base = baseToolName(name);
  if (!GATEWAYS.has(base)) return { name: base, args: input };
  const o = rec(input);
  const inner = str(o.tool);
  if (!inner) return { name: base, args: input };
  let args: unknown = o.args;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the string */ } }
  return { name: base, inner: baseToolName(inner), args: args ?? {} };
}

export interface ToolRule {
  /** Exact base name (case-insensitive) or a pattern tested against it. */
  match: string | RegExp;
  /** Read or write, or a function of the (unwrapped) args, e.g. `sn_record_manage` with `action: 'get'` only reads. */
  access: ToolAccess | ((args: Obj) => ToolAccess);
  family?: ToolFamily;
  /** Records the call targets, from its unwrapped args. */
  targets?: (args: Obj) => RecordTarget[];
  /** Its path args name files on this machine (default: only for built-in tools and local filesystem servers). */
  localPaths?: boolean;
}

const RECORD_READ_ACTIONS = new Set(['get', 'read', 'query', 'list', 'search', 'find', 'count', 'describe', 'fetch']);
const actionAccess = (a: Obj): ToolAccess => {
  const action = str(a.action)?.toLowerCase();
  return action && RECORD_READ_ACTIONS.has(action) ? 'read' : 'write';
};

const NAME_KEYS = ['name', 'api_name', 'sys_name'];
/** Update set names: only `sn_update_set_manage` reads them as the record name; other tools pass them as context. */
const UPDATE_SET_KEYS = ['update_set', 'update_set_name'];
const firstStr = (o: Obj, keys: string[]): string | undefined => {
  for (const k of keys) { const v = str(o[k]); if (v) return v; }
  return undefined;
};

/**
 * `{table, sys_id}` or `{table, name}` from common arg spellings; none when the call names no table. A
 * create sends the new record's fields in `data`, so its name is read from there too.
 */
export function recordTargetsOf(args: Obj, defaults: { table?: string; nameKeys?: string[] } = {}): RecordTarget[] {
  const table = str(args.table) ?? str(args.table_name) ?? str(args.tableName) ?? defaults.table;
  if (!table) return [];
  const sysId = str(args.sys_id) ?? str(args.sysId) ?? str(args.record_id) ?? str(args.recordId);
  const keys = defaults.nameKeys ?? NAME_KEYS;
  const name = firstStr(args, keys) ?? firstStr(rec(args.data), keys);
  const out: RecordTarget = { kind: 'record', instance: str(args.instance) ?? '', table };
  if (sysId) out.sysId = sysId;
  if (name) out.name = name;
  return [out];
}

const records = (a: Obj) => recordTargetsOf(a);
/** `sn_update_set_manage` actions that only read. */
const UPDATE_SET_READS = new Set(['current', 'list', 'get', 'preview', 'export']);
const lowerAction = (a: Obj) => str(a.action)?.toLowerCase();

/** ServiceNow (SkyForge nexus) tools. Rules are tried in order; the first match wins. */
const SERVICENOW_RULES: ToolRule[] = [
  { match: 'sn_query_table', access: 'read' },
  { match: 'sn_get_table_metadata', access: 'read' },
  { match: 'sn_get_instance_info', access: 'read' },
  { match: 'sn_session_context', access: 'read' },
  { match: 'sn_discover_platform_tables', access: 'read' },
  { match: 'sn_aggregate_metrics', access: 'read' },
  { match: 'sn_load_skill', access: 'other' },
  { match: 'tool_search', access: 'other' },
  // Pulls an instance record to local files: it reads the instance, and its path args are local files.
  { match: 'sn_pull_artifact', access: 'read', localPaths: true },
  { match: 'sn_record_manage', access: actionAccess, targets: records },
  { match: 'sn_push_artifact', access: 'write', targets: records },
  {
    // Actions seen live: switch, create, current, add_artifact, force_capture, export, list, preview, ignore.
    match: 'sn_update_set_manage',
    access: (a) => (UPDATE_SET_READS.has(lowerAction(a) ?? '') ? 'read' : 'write'),
    targets: (a) => recordTargetsOf(a, { table: 'sys_update_set', nameKeys: [...NAME_KEYS, ...UPDATE_SET_KEYS] }),
  },
  // Makes the named update set current, creating it when missing.
  { match: 'sn_ensure_active_update_set', access: 'write', targets: (a) => recordTargetsOf(a, { table: 'sys_update_set' }) },
  // Changes the session's application scope (and with create_update_set, its current update set): no app record changes.
  { match: 'sn_switch_application_scope', access: 'other' },
  { match: 'sn_execute_background_script', access: 'write' },
  { match: 'sn_schedule_script_job', access: 'write' },
  // Actions: get (read), and create_flow, create_subflow, update_flow, delete_flow, promote, populate_inputs, add_component,
  // delete_component, update_trigger (writes). Its args name the flow by sys_id or name, never by table.
  { match: 'sn_intermediate_flow', access: (a) => (lowerAction(a) === 'get' ? 'read' : 'write'), targets: (a) => recordTargetsOf(a, { table: 'sys_hub_flow' }) },
  { match: /^sn_(create|update|delete|add|remove|set|activate|deactivate|publish)_/, access: 'write', targets: records },
];

const WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'write', 'push', 'put', 'insert', 'upsert', 'patch', 'edit', 'remove', 'move', 'rename',
  'merge', 'apply', 'execute', 'exec', 'run', 'set', 'add', 'deploy', 'publish', 'commit', 'save', 'upload', 'drop', 'replace',
]);
const READ_VERBS = new Set(['get', 'list', 'search', 'query', 'read', 'fetch', 'find', 'describe', 'view', 'show', 'lookup', 'download', 'count']);

/**
 * Fallback for unknown MCP tools (prefixed names and `sn_*`): the first verb in the name decides
 * (`create_or_update_file` writes, `list_issues` reads). A name with a read verb first, such as
 * `get_or_create_x`, comes out as a read; that is accepted for a fallback, and a rule can say otherwise.
 */
function verbAccess(base: string): ToolAccess | undefined {
  for (const t of base.toLowerCase().split(/[_\-.]+/)) {
    if (WRITE_VERBS.has(t)) return 'write';
    if (READ_VERBS.has(t)) return 'read';
  }
  return undefined;
}

const extraRules: ToolRule[] = [];

/** Adds a rule ahead of the built-in ones (plugins and tests use this). Returns a function that removes it. */
export function registerToolRule(rule: ToolRule): () => void {
  extraRules.unshift(rule);
  return () => { const i = extraRules.indexOf(rule); if (i >= 0) extraRules.splice(i, 1); };
}

function ruleFor(base: string): ToolRule | undefined {
  const lower = base.toLowerCase();
  const hit = (r: ToolRule) => (typeof r.match === 'string' ? r.match.toLowerCase() === lower : r.match.test(base));
  return extraRules.find(hit) ?? SERVICENOW_RULES.find(hit);
}

export interface ToolClass {
  /** Base name of the called tool (the gateway, for a `tool_execute` call). */
  name: string;
  /** The real tool of a gateway call. */
  inner?: string;
  server?: string;
  family?: ToolFamily;
  access: ToolAccess;
  /** False when no rule, family or verb matched: attribution is blind to this tool. */
  known: boolean;
  /** Unwrapped args of the real tool. */
  args: unknown;
  targets: RecordTarget[];
}

const SYS_ID = /^[0-9a-f]{32}$/i;
const SYS_ID_TEXT = /"sys_id"\s*:\s*"([0-9a-f]{32})"/gi;
/** At most this many sys_ids are taken from text that does not parse. */
const MAX_TEXT_IDS = 5;

/** The objects a result may carry its record in: top level, `data`, `record`, `records[0]`, under `result` or not. */
function resultObjects(top: Obj): Obj[] {
  const out: Obj[] = [];
  for (const base of [top, rec(top.result)]) {
    const data = rec(base.data);
    const list = Array.isArray(data.records) ? data.records : [];
    out.push(base, data, rec(data.record), rec(list[0]));
  }
  return out;
}

/**
 * sys_ids a write result names. Nexus wraps a `tool_execute` result as
 * `{success, tool, result: {success, data: {...}}}`, so `result.data.sys_id` counts as well as `sys_id`,
 * `data.sys_id`, `data.record.sys_id` and `data.records[0].sys_id`. Output is stored cut to 4,000
 * characters, so text that does not parse falls back to the first few `"sys_id": "<32 hex>"` pairs.
 */
export function resultSysIds(output: unknown): string[] {
  let o: unknown = output;
  if (typeof o === 'string') {
    const t = o.trimStart();
    if (!t.startsWith('{')) return [];
    try { o = JSON.parse(t); } catch {
      const ids = new Set<string>();
      for (const m of t.matchAll(SYS_ID_TEXT)) { ids.add(m[1]); if (ids.size >= MAX_TEXT_IDS) break; }
      return [...ids];
    }
  }
  const out = new Set<string>();
  for (const v of resultObjects(rec(o))) {
    const id = str(v.sys_id);
    if (id && SYS_ID.test(id)) out.add(id);
  }
  return [...out];
}

/**
 * Classifies one tool call. `opts.instance` fills record targets that do not name one (the proxy
 * and plugin know which instance a session talks to); `opts.output` adds sys_ids from a create's result.
 */
export function classifyTool(name: string, input?: unknown, opts: { instance?: string; output?: unknown } = {}): ToolClass {
  const { name: base, inner, args } = unwrapTool(name, input);
  const real = inner ?? base;
  const server = toolServer(name);
  const out: ToolClass = { name: base, access: 'other', known: false, args, targets: [] };
  if (inner) out.inner = inner;
  if (server) out.server = server;
  const family = server || inner ? undefined : familyOf(real);
  const rule = ruleFor(real);
  if (family) {
    out.family = family;
    out.access = WRITE_FAMILIES.has(family) ? 'write' : READ_FAMILIES.has(family) ? 'read' : 'other';
    out.known = true;
  } else if (rule) {
    if (rule.family) out.family = rule.family;
    out.access = typeof rule.access === 'function' ? rule.access(rec(args)) : rule.access;
    out.known = true;
    if (rule.targets && out.access === 'write') out.targets = rule.targets(rec(args));
  } else if (GATEWAYS.has(real)) {
    // A gateway that names no inner tool: nothing to classify.
    out.access = 'other';
  } else if (server || /^sn_/.test(real)) {
    // Only MCP tools: a built-in agent tool such as Codex's `update_plan` is not a write.
    const v = verbAccess(real);
    if (v) { out.access = v; out.known = true; }
  }
  if (out.access === 'write' && opts.output !== undefined) {
    const ids = resultSysIds(opts.output);
    if (ids.length) {
      const t0 = out.targets[0];
      const table = t0?.table ?? str(rec(args).table);
      if (table) for (const id of ids) if (!out.targets.some((t) => t.sysId === id)) out.targets.push({ kind: 'record', instance: '', table, sysId: id, ...(t0?.name ? { name: t0.name } : {}) });
    }
  }
  if (opts.instance) for (const t of out.targets) if (!t.instance) t.instance = opts.instance;
  return out;
}

/** MCP servers whose path args name files on this machine. Other servers (GitHub, for one) name remote paths. */
export const LOCAL_FS_SERVERS = new Set(['filesystem', 'fs', 'desktop-commander']);

/**
 * Whether a call's path args are files on this machine: built-in agent tools and local filesystem MCP
 * servers say yes; a rule can say so for its tool (`sn_pull_artifact`); other MCP and ServiceNow tools
 * say no, since a GitHub `path` or a nexus `file_path` is not a local file the call wrote.
 */
export function takesLocalPaths(name: string, input?: unknown): boolean {
  const { inner, name: base } = unwrapTool(name, input);
  const real = inner ?? base;
  const rule = ruleFor(real);
  if (rule) return !!rule.localPaths;
  const server = toolServer(name);
  if (server) return LOCAL_FS_SERVERS.has(server.toLowerCase()) && !inner;
  return !inner && !/^sn_/.test(real);
}

/** True when the call can change files or records. */
export const isWriteCall = (name: string, input?: unknown): boolean => classifyTool(name, input).access === 'write';

/** Same record: same table and sys_id, or (when the target has no sys_id) the same name. Instances must agree when both are set. */
export function sameRecord(a: RecordTarget, b: { instance?: string; table: string; sysId?: string; name?: string }): boolean {
  if (a.table !== b.table) return false;
  if (a.instance && b.instance && a.instance !== b.instance) return false;
  if (a.sysId && b.sysId) return a.sysId === b.sysId;
  return !!a.name && !!b.name && a.name === b.name;
}
