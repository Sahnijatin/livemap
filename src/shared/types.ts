import type { RecordTarget, ToolAccess } from './tools.js';

export type Lang = 'typescript'|'tsx'|'javascript'|'python'|'go'|'rust'|'java'|'kotlin'|'csharp'|'php'|'ruby'|'swift'|'c'|'cpp'|'dart'|'vue'|'svelte'|'sql'|'prisma'|'markdown'|'json'|'yaml'|'toml'|'css'|'html'|'shell'|'text'|'secret'|'other';
export type SymbolKind = 'function'|'method'|'class'|'component'|'hook'|'interface'|'type'|'enum'|'struct'|'trait'|'impl'|'module'|'namespace'|'variable'|'heading';
export interface CodeSymbol { name: string; qname: string; kind: SymbolKind; signature: string; line: number; endLine: number; exported: boolean; hash: string; children: CodeSymbol[] }
export interface Route {
  method: string; path: string; handler?: string; line: number; kind: 'api' | 'page' | 'screen'; framework: string;
  /** Flask: the Blueprint's own url_prefix, already in `path`; a register_blueprint url_prefix replaces it. */
  basePrefix?: string;
}
/** A router mounted under a prefix; `target` is the resolved root-relative file, null when unresolved. */
export interface Mount {
  prefix: string; spec: string; target: string | null; line: number; framework: string;
  /** Flask register_blueprint with an explicit url_prefix: it replaces the blueprint's own prefix. */
  replaces?: true;
}
export interface Field { name: string; type: string; /** Database column name when it differs from `name` (Prisma `@map`). */ column?: string; line?: number; pk?: true; required?: true; unique?: true; fk?: { table: string; field: string }; relation?: { model: string; many: boolean } }
/**
 * `partial` marks an ALTER fragment that changes a table defined elsewhere: `fields` it adds, plus the
 * columns it drops and renames (`[from, to]`), applied in migration order when tables are merged.
 */
export interface Entity {
  name: string; table: string; orm: string; file: string; line: number; fields: Field[]; partial?: true;
  dropped?: string[]; renamed?: [string, string][];
}
export interface Dep { name: string; version: string; eco: string; dev?: boolean; line?: number }
/**
 * Logic that runs on a table (and field), outside the table's own definition: a ServiceNow business rule,
 * client script, UI policy, ACL or data policy. `when` is the trigger (`before`, `onChange`, `read`), and
 * `order` the position among rules that fire together.
 */
export interface Rule {
  kind: 'business_rule' | 'client_script' | 'ui_policy' | 'acl' | 'data_policy' | 'ui_action';
  name: string; table: string; field?: string; when?: string; order?: number; condition?: string;
  actions?: string[]; active?: boolean; line: number;
}
export interface FileModel {
  path: string; lang: Lang; size: number; lines: number;
  symbols: CodeSymbol[]; imports: { local: string[]; external: string[] };
  routes: Route[]; entities: Entity[]; env: string[]; mounts?: Mount[]; deps?: { deps: Dep[]; scripts?: Record<string, string> };
  /** Rules on tables this file defines (see Rule); only set when there are some. */
  rules?: Rule[];
  flags: { binary?: true; tooLarge?: true; secret?: true; parseError?: true };
}
export interface SymRef { name: string; qname: string; kind: SymbolKind; signature: string; line: number }
export interface Hunk { oldStart: number; newStart: number; lines: string[] }
export interface ChangeSummary {
  id: number; path: string; kind: 'created'|'modified'|'deleted'; at: number; lang: Lang;
  symbols: { added: SymRef[]; removed: SymRef[]; modified: (SymRef & { signatureChanged: boolean; before?: string })[] };
  routes: { added: Route[]; removed: Route[] };
  entities: { added: { name: string; fields: number; orm: string }[]; removed: { name: string }[]; changed: { name: string; addedFields: string[]; removedFields: string[]; changedFields: string[] }[] };
  imports: { added: string[]; removed: string[]; externalAdded: string[] };
  deps?: { added: Dep[]; removed: Dep[]; changed: (Dep & { from: string })[] };
  env: { added: string[]; removed: string[] };
  lines: { added: number; removed: number }; hunks: Hunk[]; truncated: boolean;
  attribution?: Attribution;
  /** AI one-liner, when summaries are enabled. Plain text. */
  summary?: string;
}

export type AgentKind = 'claude-code' | 'codex' | 'cursor' | 'git' | 'other';
export type AgentEventType = 'prompt' | 'message' | 'thinking' | 'tool_start' | 'tool_end' | 'commit' | 'status';
/**
 * `inner` is the real tool of a gateway call (`tool_execute`), `access` its read or write class, and
 * `targets` the records it names (see src/shared/tools.ts). Older events may lack all three.
 */
export interface AgentTool {
  id?: string; name: string; label: string; input?: unknown; output?: string; ok?: boolean; paths: string[];
  inner?: string; access?: ToolAccess; targets?: RecordTarget[];
}
/** `paths` and `seenAt` are set on git commit events: the root-relative files the commit changed and when LiveMap saw it. */
export interface AgentEvent { id: number; agent: AgentKind; sessionId: string; at: number; type: AgentEventType; text?: string; tool?: AgentTool; status?: 'working' | 'idle'; subagent?: boolean; paths?: string[]; seenAt?: number }
/** An event as emitted by a normalizer; the hub assigns `id`. */
export type RawAgentEvent = Omit<AgentEvent, 'id'>;
export interface AgentSession { id: string; agent: AgentKind; title: string; cwd: string; startedAt: number; lastAt: number; status: 'working' | 'idle'; transcriptPath?: string; hooks: boolean }
export interface Attribution { agent: AgentKind; sessionId: string; eventId?: number; confidence: 'exact' | 'likely'; intent?: string }
export interface Flag { id: number; target: string | null; note: string; createdAt: number; deliveredAt?: number; deliveredTo?: { agent: AgentKind; sessionId: string } }
export interface ControlState { paused: boolean; flags: Flag[] }
