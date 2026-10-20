/**
 * SkyForge's own log (`~/.skyforge/skyforge-mcp.log`) as evidence for history attribution.
 *
 * Each tool call writes a start line and, often, a completion line:
 *
 *   [2026-06-03T16:01:29.115Z] [INFO] [Tool] tool_execute | tool=sn_create_field, table=t, column_label=Label
 *   [2026-06-03T16:01:30.871Z] [INFO] [Tool] sn_create_field ✅ 1756ms
 *
 * Argument values are cut at about 100 characters, long argument lists end in `, ...+N more`, and there is no
 * session id. The instance is only known from the last `[Auth] ✅ Connected to <host>` line. A completion line
 * says the call returned, not that the write succeeded. So a call is matched to a history event only by what it
 * names: the record's sys_id (updates and deletes), else its table and name (creates). A match on table and time
 * alone, a background script, or a call on an unknown instance is never more than `likely`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { HistoryEvent, LogRef } from './history.js';

export const DEFAULT_SKYFORGE_LOG = path.join(os.homedir(), '.skyforge', 'skyforge-mcp.log');
export const DEFAULT_LOG_WINDOW_MS = 60_000;
/** How far an event may come before its call's start (clock drift between the instance and this machine). */
export const LOG_LEAD_MS = 2_000;

export interface LogCall {
  /** 1-based line number of the start line (blank lines count). */
  line: number;
  at: number;
  /** Set when a completion line was paired with this call. */
  end?: number;
  ms?: number;
  /** The real tool (the inner tool of a `tool_execute`). */
  tool: string;
  /** `capture`: writes records into an update set again; `script`: runs code that can write anything. */
  kind: 'create' | 'update' | 'delete' | 'capture' | 'script';
  /** The tables the call writes records of; empty when the tool and its arguments do not say. */
  tables: string[];
  /** The call can write any table (scripts, tools LiveMap has no table for): never more than `likely`. */
  anyTable?: true;
  /** The table that record belongs to (a field's or business rule's table), when given. */
  collection?: string;
  sysId?: string;
  /** Lowercased full names the call gives the record (id, name, title, label, ...). */
  names: string[];
  /** The instance the log last connected to before this call; unset when unknown or when another instance
   *  connected in the 10 minutes before it (several SkyForge processes write the same file). */
  host?: string;
  /** The ServiceNow user SkyForge said it works as (`servicenow_username=`) on this call's instance, lowercased.
   *  Set only when that was said while the log was on the same known instance. */
  user?: string;
}

const START = /^\[([^\]]+)\] \[(\w+)\] \[Tool\] (\S+) \| (.*)$/;
const DONE = /^\[([^\]]+)\] \[(\w+)\] \[Tool\] (\S+) (?:✅|❌|✔|✖)\s*(\d+)\s*ms\b/;
const AUTH = /^\[([^\]]+)\] \[\w+\] \[Auth\] (?:✅\s*)?Connected to\s+(\S+)/;
/** Another instance connecting this soon before a call makes the call's instance unknown. */
export const HOST_MIX_MS = 10 * 60_000;
const SYS_ID = /^[0-9a-f]{32}$/i;
const TABLE = /^[a-z][a-z0-9_]*$/;

/**
 * An instance as a short name: `https://acme.service-now.com/`, `acme.service-now.com` and `acme` are `acme`.
 * Any other host is not an instance name LiveMap can compare: null (unknown).
 */
export function instanceName(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '');
  if (h.endsWith('.service-now.com')) return h.slice(0, -'.service-now.com'.length) || null;
  return /^[a-z0-9-]+$/.test(h) ? h : null;
}

/** `k=v, k=v` as logged; a value can hold `, ` itself, so only `, key=` starts a new pair. */
export function parseArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // `, ...+N more` stands for arguments left out; it is not part of the value before it.
  for (const part of text.replace(/,\s*\.\.\.\+\d+ more\b/g, '').split(/, (?=[a-z_][a-z0-9_]*=)/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** A logged value usable as a name: not cut short, not an object, not redacted (the test fixture redacts). */
function full(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s || s === '<redacted>' || s.includes('...') || /^(Array|Object)\(\d+\)$/.test(s) || /^[[{]/.test(s)) return undefined;
  return s;
}

/**
 * Create tools and the record table they write. `collection` names the argument that holds the table the new
 * record belongs to (for those tools `table=` is not the record's own table).
 */
const CREATES: Record<string, { table: string; collection?: string }> = {
  sn_create_field: { table: 'sys_dictionary', collection: 'table' },
  sn_create_choice: { table: 'sys_choice', collection: 'table' },
  sn_create_table: { table: 'sys_db_object' },
  sn_create_sp_widget: { table: 'sp_widget' },
  sn_create_sp_page: { table: 'sp_page' },
  sn_create_portal: { table: 'sp_portal' },
  sn_create_portal_theme: { table: 'sp_theme' },
  sn_create_portal_menu: { table: 'sp_instance_menu' },
  sn_create_script_include: { table: 'sys_script_include' },
  sn_create_business_rule: { table: 'sys_script', collection: 'table' },
  sn_create_client_script: { table: 'sys_script_client', collection: 'table' },
  sn_create_ui_action: { table: 'sys_ui_action', collection: 'table' },
  sn_create_ui_policy: { table: 'sys_ui_policy', collection: 'table' },
  sn_create_ui_page: { table: 'sys_ui_page' },
  sn_create_ui_script: { table: 'sys_ui_script' },
  sn_create_form_section: { table: 'sys_ui_section', collection: 'table' },
  sn_create_notification: { table: 'sysevent_email_action', collection: 'table' },
  sn_create_acl: { table: 'sys_security_acl' },
  sn_create_access_control: { table: 'sys_security_acl' },
  sn_create_role: { table: 'sys_user_role' },
  sn_create_catalog_item: { table: 'sc_cat_item' },
  sn_create_catalog_variable: { table: 'item_option_new' },
  sn_create_record_producer: { table: 'sc_cat_item_producer' },
  sn_create_ai_agent: { table: 'sn_aia_agent' },
  sn_create_ux_app_route: { table: 'sys_ux_app_route' },
  sn_create_scheduled_job: { table: 'sysauto_script' },
  sn_create_scripted_rest_api: { table: 'sys_ws_definition' },
  sn_create_rest_message: { table: 'sys_rest_message' },
  sn_create_event: { table: 'sysevent_register' },
  sn_create_script_action: { table: 'sysevent_script_action' },
  sn_create_data_policy: { table: 'sys_data_policy2', collection: 'table' },
  sn_create_application_menu: { table: 'sys_app_application' },
  sn_create_module: { table: 'sys_app_module' },
  sn_create_system_property: { table: 'sys_properties' },
  sn_create_property: { table: 'sys_properties' },
  sn_create_flow: { table: 'sys_hub_flow' },
};

/** `sn_artifact_manage` types that are not table names themselves. */
const ARTIFACT_TYPES: Record<string, string> = {
  widget: 'sp_widget', page: 'sp_page', portal: 'sp_portal', theme: 'sp_theme',
  script_include: 'sys_script_include', business_rule: 'sys_script', client_script: 'sys_script_client',
  ui_action: 'sys_ui_action', ui_policy: 'sys_ui_policy', ui_page: 'sys_ui_page', ui_script: 'sys_ui_script',
  notification: 'sysevent_email_action', acl: 'sys_security_acl', flow: 'sys_hub_flow', scheduled_job: 'sysauto_script',
  script_action: 'sysevent_script_action', ui_macro: 'sys_ui_macro', email_notification: 'sysevent_email_action',
};
/** An `artifact_type` or `type` argument as a table: a known type, or a name that looks like a table. */
const artifactTable = (v: string | undefined): string | undefined => {
  const t = full(v)?.toLowerCase();
  if (!t) return undefined;
  return ARTIFACT_TYPES[t] ?? (TABLE.test(t) && /^(sys|sp|sn|sc|x|u|item|cmdb|sysevent|sysauto|ua)_/.test(t) ? t : undefined);
};

/**
 * Tools whose `action` (or `operation`) says what they do. Only create, update, delete, set and run actions
 * write; get, list, query and the rest read. `tables` are the tables they write; none means any table. A run
 * action executes code, like a background script.
 */
const MANAGED: Record<string, { tables: string[]; runs?: true }> = {
  sn_catalog_item_manager: { tables: ['sc_cat_item'] },
  sn_email_notification_manage: { tables: ['sysevent_email_action'] },
  sn_property_manager: { tables: ['sys_properties'] },
  sn_rest_message_manage: { tables: ['sys_rest_message', 'sys_rest_message_fn'] },
  sn_scheduled_job_manage: { tables: ['sysauto_script'], runs: true },
  sn_uib_page_manage: { tables: ['sys_ux_screen'] },
  sn_manage_workspace_navigation: { tables: [] },
  sn_configure_macroponent: { tables: [] },
  sn_plugin_manage: { tables: [], runs: true },
};
/** Writes with no action argument: their kind, and the tables they write (none: any table). A read action, if
 *  one is given after all, still makes the call a read. */
const DIRECT: Record<string, { kind: LogCall['kind']; tables: string[] }> = {
  sn_decision_create: { kind: 'create', tables: ['sys_decision'] },
  sn_par_create_dashboard: { kind: 'create', tables: [] },
  sn_par_update_dashboard: { kind: 'update', tables: [] },
  sn_wire_dashboard_home: { kind: 'update', tables: [] },
  sn_scripted_rest_api: { kind: 'update', tables: ['sys_ws_definition', 'sys_ws_operation'] },
  sn_manage_workspace_list_config: { kind: 'update', tables: [] },
  sn_assign_tool_to_agent: { kind: 'update', tables: [] },
  sn_bulk_update: { kind: 'update', tables: [] },
  sn_cleanup_workspace_t2e: { kind: 'script', tables: [] },
  sn_invoke_ai_agent: { kind: 'script', tables: [] },
};
/** What an action does: null for reads. */
function actionKind(action: string): 'create' | 'update' | 'delete' | 'run' | null {
  if (/^(create|add|insert)/.test(action)) return 'create';
  if (/^(update|set|edit|assign|configure|remove_from|reorder)/.test(action)) return 'update';
  if (/^(delete|remove)/.test(action)) return 'delete';
  if (/^(run|execute|trigger|activate|install|upgrade|repair)/.test(action)) return 'run';
  return null;
}
const PORTAL_LAYOUT = ['sp_container', 'sp_row', 'sp_column', 'sp_instance'];
/** Records a flow designer step adds to a flow, besides the flow itself. */
const FLOW_PARTS = ['sys_hub_flow', 'sys_hub_trigger_instance', 'sys_hub_action_instance', 'sys_hub_flow_logic', 'sys_hub_sub_flow_instance', 'sys_hub_flow_variable'];

/** Tools that only read or change session state (update set selection included). */
const READS = new Set([
  'sn_query_table', 'sn_get_table_metadata', 'sn_get_instance_info', 'sn_session_context', 'sn_pull_artifact',
  'sn_get_current_scope', 'sn_switch_application_scope', 'sn_discover_platform_tables', 'sn_table_schema_discovery',
  'sn_load_skill', 'sn_plan_ai_agent', 'tool_search', 'tool_execute', 'sn_update_set_query', 'sn_ensure_active_update_set',
  'sn_aggregate_metrics', 'sn_blast_radius_apps', 'sn_blast_radius_artifact_dependencies', 'sn_blast_radius_impact_map',
  'sn_blast_radius_reverse_dependencies', 'sn_blast_radius_table_configs', 'sn_catalog_item_search', 'sn_code_search',
  'sn_data_export', 'sn_decision_evaluate', 'sn_decision_get', 'sn_decision_list', 'sn_deployment_debug',
  'sn_deployment_status', 'sn_elevate_role', 'sn_export_to_xml', 'sn_inspect_mutations', 'sn_par_get_dashboard',
  'sn_property_query', 'sn_uib_discover',
]);
const READ_PREFIX = /^sn_(get|list|search|find|validate|check|analyze|describe|discover|preview|explain|plan)_/;

/** What LiveMap makes of a tool: a write it knows, a read, or a tool it does not know (counted as a read). */
export function toolRole(tool: string): 'write' | 'read' | 'unknown' {
  if (READS.has(tool) || READ_PREFIX.test(tool)) return 'read';
  if (CREATES[tool] || MANAGED[tool] || DIRECT[tool] || GENERIC_WRITE.test(tool)) return 'write';
  if (['sn_record_manage', 'sn_edit_by_sysid', 'sn_push_artifact', 'sn_update_sp_widget', 'sn_artifact_manage', 'sn_add_form_field',
    'sn_build_portal_layout', 'sn_intermediate_flow', 'sn_disable_business_rule', 'sn_execute_background_script', 'sn_schedule_script_job',
    'sn_update_set_manage'].includes(tool)) return 'write';
  return 'unknown';
}
/** Create, update and delete tools LiveMap has no entry for. Update set tools are not record writes. */
const GENERIC_WRITE = /^sn_(create|update|delete)_(?!set_)/;

/** Turns one start line into a write call, or null for reads and anything that names no record. */
export function toCall(line: number, at: number, outer: string, args: Record<string, string>): LogCall | null {
  const tool = /^[a-z0-9_]+/.exec(outer === 'tool_execute' ? args.tool ?? outer : outer)?.[0] ?? outer;
  const action = (args.action ?? args.operation ?? '').trim().toLowerCase();
  const names = new Set<string>();
  const name = (v: string | undefined) => { const s = full(v); if (s) names.add(s.toLowerCase()); };
  for (const k of ['id', 'name', 'title', 'url_suffix', 'column_label', 'label', 'api_name']) name(args[k]);
  let sysId: string | undefined;
  for (const k of ['sys_id', 'widget_id', 'flow_id', 'flow_sys_id', 'record_id', 'record_sys_id', 'artifact_sys_id']) {
    const v = args[k]?.trim();
    if (v && SYS_ID.test(v)) { sysId ??= v.toLowerCase(); } else if (k === 'widget_id') name(v);
  }
  const argTable = full(args.table);
  const tableArg = argTable && TABLE.test(argTable) ? argTable : undefined;
  const make = (kind: LogCall['kind'], tables: string[], extra: Partial<LogCall> = {}): LogCall => ({ line, at, tool, kind, tables, names: [], ...extra });

  let call: LogCall | null = null;
  const create = CREATES[tool];
  if (create) {
    call = make('create', [create.table]);
    const coll = create.collection ? full(args[create.collection]) : undefined;
    if (coll) call.collection = coll.toLowerCase();
    // A field's column name is its element, and its update name ends in it.
    if (tool === 'sn_create_field' || tool === 'sn_create_choice') { name(args.column_name); name(args.element); }
  } else if (tool === 'sn_record_manage' || tool === 'sn_artifact_manage') {
    const kind = action === 'create' ? 'create' : action === 'update' ? 'update' : action === 'delete' ? 'delete' : null;
    const table = tableArg ?? artifactTable(args.type ?? args.artifact_type);
    if (kind) call = table ? make(kind, [table]) : make(kind, [], sysId || kind === 'delete' ? {} : { anyTable: true });
  } else if (tool === 'sn_edit_by_sysid' || tool === 'sn_push_artifact') {
    call = make('update', tableArg ? [tableArg] : []);
    // `.../artifacts/<app>/<table>/<Record name>`: the folder names the table and the record.
    const dir = full(args.directory)?.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    if (dir && dir.length >= 2) {
      if (!call.tables.length && TABLE.test(dir[dir.length - 2]) && dir[dir.length - 2].includes('_')) call.tables = [dir[dir.length - 2]];
      names.add(dir[dir.length - 1].toLowerCase());
    }
  } else if (tool === 'sn_update_sp_widget') {
    call = make('update', ['sp_widget']);
  } else if (tool === 'sn_disable_business_rule') {
    call = make('update', ['sys_script']);
  } else if (tool === 'sn_add_form_field') {
    call = make('create', ['sys_ui_element']);
    if (tableArg) call.collection = tableArg;
    for (const k of ['field', 'field_name', 'element', 'column_name']) name(args[k]);
  } else if (tool === 'sn_build_portal_layout') {
    call = make('create', PORTAL_LAYOUT);
  } else if (tool === 'sn_intermediate_flow') {
    if (action === 'create_flow' || action === 'create_subflow') call = make('create', ['sys_hub_flow']);
    else if (action === 'create_action') call = make('create', ['sys_hub_action_type_definition']);
    else if (action.startsWith('create_')) call = make('create', FLOW_PARTS);
    else if (action === 'delete_flow') call = make('delete', ['sys_hub_flow']);
  } else if (tool === 'sn_update_set_manage') {
    // Adding a record to an update set writes its update_xml row again, without saving the record.
    if (['add_artifact', 'force_capture', 'capture', 'add_record'].includes(action)) {
      // `artifact_type` can be a type (`script_include`) rather than a table.
      const t = [args.artifact_table, args.artifact_type, args.table].map(artifactTable).find(Boolean);
      call = make('capture', t ? [t] : [], t || sysId ? {} : { anyTable: true });
      name(args.artifact_name);
    }
  } else if (tool === 'sn_execute_background_script' || tool === 'sn_schedule_script_job') {
    return { line, at, tool, kind: 'script', tables: [], anyTable: true, names: [] };
  } else if (MANAGED[tool]) {
    const spec = MANAGED[tool];
    const kind = actionKind(action);
    if (kind === 'run') call = spec.runs ? make('script', [], { anyTable: true }) : make('update', spec.tables, spec.tables.length ? {} : { anyTable: true });
    else if (kind) call = make(kind, spec.tables, spec.tables.length ? {} : { anyTable: true });
  } else if (DIRECT[tool]) {
    const acted = action ? actionKind(action) : null;
    if (action && !acted) return null;
    const spec = DIRECT[tool];
    const kind = acted && acted !== 'run' ? acted : spec.kind;
    const tables = spec.tables.length ? spec.tables : tableArg && kind !== 'script' ? [tableArg] : [];
    call = make(kind, tables, tables.length ? {} : { anyTable: true });
  } else if (/^sn_update_set_/.test(tool)) {
    return null;
  } else if (/^sn_create_/.test(tool)) {
    // A create tool LiveMap has no table for: its `table=` is often the parent table, not the record's.
    call = make('create', [], { anyTable: true });
  } else if (/^sn_update_/.test(tool)) {
    call = make('update', tableArg ? [tableArg] : [], tableArg || sysId ? {} : { anyTable: true });
  } else if (/^sn_delete_/.test(tool)) {
    call = make('delete', tableArg ? [tableArg] : [], tableArg || sysId ? {} : { anyTable: true });
  }
  if (!call) return null;
  call.names = [...names];
  if (sysId) call.sysId = sysId;
  return call;
}

export interface LogScan {
  lines: number;
  parsed: number;
  calls: LogCall[];
  /** Tools LiveMap does not know, with their call counts; they are treated as reads. */
  unknownTools: Record<string, number>;
  /** Instance hosts the log connected to. */
  hosts: string[];
  /** Every ServiceNow user SkyForge said it works as, per instance. */
  agentUsers: Record<string, string[]>;
}

/** Reads log lines (a whole file's text, or lines one by one) into write calls, completions paired. */
export class LogReader {
  readonly calls: LogCall[] = [];
  readonly unknownTools: Record<string, number> = {};
  private readonly hosts = new Set<string>();
  lines = 0;
  parsed = 0;
  /** The host of the last connect line (null: one LiveMap cannot name), and when each host last connected. */
  private host: string | null = null;
  private readonly connected = new Map<string, number>();
  /** The ServiceNow user SkyForge said it works as, per instance it said so on. */
  private readonly users = new Map<string, string>();
  private readonly seen = new Map<string, Set<string>>();
  /** Starts per tool still waiting for a completion line. */
  private open = new Map<string, LogCall[]>();
  constructor(private readonly range?: { from: number; to: number }) {}

  add(text: string): void {
    this.lines++;
    const line = this.lines;
    if (!text) return;
    let m = START.exec(text);
    if (m) {
      const at = Date.parse(m[1]);
      if (Number.isNaN(at)) return;
      this.parsed++;
      const args = parseArgs(m[4]);
      // The ServiceNow user SkyForge works as, from scope and update set calls.
      const user = full(args.servicenow_username)?.toLowerCase();
      const here = this.hostAt(at);
      if (user && here) {
        this.users.set(here, user);
        if (!this.seen.has(here)) this.seen.set(here, new Set());
        this.seen.get(here)!.add(user);
      }
      if (this.range && (at < this.range.from || at > this.range.to)) return;
      const call = toCall(line, at, m[3], args);
      if (!call) {
        const tool = /^[a-z0-9_]+/.exec(m[3] === 'tool_execute' ? args.tool ?? '' : m[3])?.[0];
        if (tool && toolRole(tool) === 'unknown') this.unknownTools[tool] = (this.unknownTools[tool] ?? 0) + 1;
        return;
      }
      const host = this.hostAt(at);
      if (host) call.host = host;
      const agent = host ? this.users.get(host) : undefined;
      if (agent) call.user = agent;
      this.calls.push(call);
      const list = this.open.get(call.tool) ?? [];
      list.push(call);
      this.open.set(call.tool, list);
      return;
    }
    m = AUTH.exec(text);
    if (m) {
      this.parsed++;
      this.host = instanceName(m[2]);
      const at = Date.parse(m[1]);
      if (this.host) {
        this.hosts.add(this.host);
        if (!Number.isNaN(at)) this.connected.set(this.host, at);
      } else if (!Number.isNaN(at)) this.connected.set('', at);
      return;
    }
    m = DONE.exec(text);
    if (!m) return;
    const end = Date.parse(m[1]);
    if (Number.isNaN(end)) return;
    this.parsed++;
    const ms = Number(m[4]);
    // The start this line closes: the open call of that tool whose start plus duration is nearest its time.
    const list = this.open.get(m[3]);
    if (!list?.length) return;
    let best = -1;
    let gap = Infinity;
    list.forEach((c, i) => {
      const g = Math.abs(c.at + ms - end);
      if (g < gap) { gap = g; best = i; }
    });
    if (best < 0 || gap > 1000) return;
    const [c] = list.splice(best, 1);
    c.end = end;
    c.ms = ms;
  }

  /**
   * The instance a call at `at` ran on: the last connect line's, unless another instance (or one LiveMap cannot
   * name) connected within HOST_MIX_MS before it. Then two SkyForge processes may share the log.
   */
  private hostAt(at: number): string | undefined {
    if (!this.host) return undefined;
    for (const [h, t] of this.connected) if (h !== this.host && t <= at && at - t < HOST_MIX_MS) return undefined;
    return this.host;
  }

  result(): LogScan {
    return {
      lines: this.lines, parsed: this.parsed, calls: this.calls, unknownTools: this.unknownTools, hosts: [...this.hosts].sort(),
      agentUsers: Object.fromEntries([...this.seen].map(([h, u]) => [h, [...u].sort()])),
    };
  }
}

export function parseLog(text: string, range?: { from: number; to: number }): LogScan {
  const r = new LogReader(range);
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) r.add(line);
  return r.result();
}

/** Reads the log file line by line (it grows for months); null when it does not exist. */
export async function readLogFile(file: string, range?: { from: number; to: number }): Promise<LogScan | null> {
  if (!fs.existsSync(file)) return null;
  const r = new LogReader(range);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) r.add(line);
  return r.result();
}

export interface MatchCounts {
  /** Saves matched (recaptures are matched too, but not counted). */
  events: number;
  matched: number;
  /** Several calls name the record. */
  ambiguous: number;
  /** One call names the record, but its instance is unknown. */
  hostUnknown: number;
  /** Calls share only the record's table (or can write any table) and time, and the author is the agent's. */
  timeOnly: number;
  /** The same, but the agent's ServiceNow user is unknown, so the author was not checked. */
  authorUnchecked: number;
  unmatched: number;
}

export interface MatchOptions {
  windowMs?: number;
  /** The mirrored instance. Calls on another instance are dropped; calls on an unknown one stay `likely`. */
  instance: string | null;
  /** The ServiceNow user nexus works as on this instance (`sn_session_context`). It wins over the log's. */
  agentUser?: string | null;
}

const ref = (c: LogCall): LogRef => (c.ms === undefined ? { line: c.line, at: c.at, tool: c.tool } : { line: c.line, at: c.at, tool: c.tool, ms: c.ms });

/** The kind of call that can make an event of each kind. */
const KINDS: Record<HistoryEvent['kind'], LogCall['kind'][]> = {
  created: ['create', 'update'], modified: ['create', 'update'], deleted: ['delete'], captured: ['capture'],
};

/**
 * Attributes events to log calls, in place, and counts the outcome.
 *
 * - A candidate starts at most LOG_LEAD_MS after the event and ends at most `windowMs` before it, on the
 *   mirrored instance. It writes the event's table with the right kind of call, or can write any table. It is
 *   not for another collection, and does not name another sys_id.
 * - It names the event's record when its sys_id matches, or one of its names does (for a dictionary entry,
 *   also when `sys_dictionary_<collection>_<name>` is the update name).
 * - One naming candidate on a known instance: `log`, and that call is used up for table and time matches.
 *   Several, or one on an unknown instance: `likely`, with all of them. Candidates that name nothing (table
 *   and time only, or any table): `likely`, with all of them, never `log`, and only when the save's author is
 *   the agent's ServiceNow user (`agentUser`, else the call's `user`). With no known user they still count, as
 *   `author not checked`. None: the event stays `history`.
 */
export function matchHistory(events: HistoryEvent[], calls: LogCall[], opts: MatchOptions): MatchCounts {
  const windowMs = opts.windowMs ?? DEFAULT_LOG_WINDOW_MS;
  const instance = opts.instance ? instanceName(opts.instance) : null;
  const sorted = calls.filter(c => !c.host || !instance || c.host === instance).sort((a, b) => a.at - b.at);
  const known = (c: LogCall) => Boolean(c.host && instance);
  const agentUser = opts.agentUser?.toLowerCase() || undefined;
  const counts: MatchCounts = { events: 0, matched: 0, ambiguous: 0, hostUnknown: 0, timeOnly: 0, authorUnchecked: 0, unmatched: 0 };
  const plans = events.map(e => {
    // Calls whose start can be in range (a call's span can run past its start).
    let lo = 0;
    let hi = sorted.length;
    const from = e.at - windowMs - 10 * 60_000;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].at < from) lo = mid + 1; else hi = mid; }
    const near: LogCall[] = [];
    const named: LogCall[] = [];
    let unchecked = false;
    const sysId = e.sysId?.toLowerCase();
    const author = e.author.toLowerCase();
    /** A call that does not name the record is a candidate only when the save's author is the agent's user. */
    const loose = (c: LogCall) => {
      const user = agentUser ?? c.user;
      if (!user) unchecked = true;
      else if (user !== author) return;
      near.push(c);
    };
    for (let i = lo; i < sorted.length && sorted[i].at <= e.at + LOG_LEAD_MS; i++) {
      const c = sorted[i];
      if (e.at < c.at - LOG_LEAD_MS || e.at > (c.end ?? c.at) + windowMs) continue;
      if (c.sysId && sysId && c.sysId !== sysId) continue;
      if (c.kind !== 'script' && !KINDS[e.kind].includes(c.kind)) continue;
      if (c.anyTable) { loose(c); continue; }
      const sameId = c.sysId !== undefined && c.sysId === sysId;
      if (!c.tables.includes(e.table) && !sameId) continue;
      if (c.collection && e.collection && c.collection !== e.collection.toLowerCase()) continue;
      const dictName = c.collection !== undefined && c.names.some(n => e.update === `${e.table}_${c.collection}_${n}`);
      if (sameId || dictName || c.names.some(n => e.keys.includes(n))) named.push(c);
      else loose(c);
    }
    return { e, near, named, unchecked };
  });
  // Calls that name exactly one record's save are spent on it.
  const used = new Set<LogCall>();
  for (const p of plans) if (p.named.length === 1 && known(p.named[0])) used.add(p.named[0]);
  for (const { e, near, named, unchecked } of plans) {
    const tally = e.kind !== 'captured';
    if (tally) counts.events++;
    delete e.log;
    delete e.reason;
    const rest = near.filter(c => !used.has(c));
    let outcome: Exclude<keyof MatchCounts, 'events'>;
    if (named.length === 1 && known(named[0])) {
      e.confidence = 'log';
      e.log = [ref(named[0])];
      outcome = 'matched';
    } else if (named.length) {
      e.confidence = 'likely';
      e.log = named.map(ref);
      outcome = named.length > 1 ? 'ambiguous' : 'hostUnknown';
    } else if (rest.length) {
      e.confidence = 'likely';
      e.log = rest.map(ref);
      // A candidate whose user is unknown: the save may be anyone's.
      const anyUnchecked = unchecked && rest.some(c => !(agentUser ?? c.user));
      if (anyUnchecked) e.reason = 'author not checked';
      outcome = anyUnchecked ? 'authorUnchecked' : 'timeOnly';
    } else {
      e.confidence = 'history';
      outcome = 'unmatched';
    }
    if (tally) counts[outcome]++;
  }
  return counts;
}
