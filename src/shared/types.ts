export type Lang = 'typescript'|'tsx'|'javascript'|'python'|'go'|'rust'|'java'|'kotlin'|'csharp'|'php'|'ruby'|'swift'|'c'|'cpp'|'dart'|'vue'|'svelte'|'sql'|'prisma'|'markdown'|'json'|'yaml'|'toml'|'css'|'html'|'shell'|'text'|'secret'|'other';
export type SymbolKind = 'function'|'method'|'class'|'component'|'hook'|'interface'|'type'|'enum'|'struct'|'trait'|'impl'|'module'|'namespace'|'variable'|'heading';
export interface CodeSymbol { name: string; qname: string; kind: SymbolKind; signature: string; line: number; endLine: number; exported: boolean; hash: string; children: CodeSymbol[] }
export interface Route { method: string; path: string; handler?: string; line: number }
export interface Field { name: string; type: string; pk?: true; required?: true; unique?: true; fk?: { table: string; field: string }; relation?: { model: string; many: boolean } }
export interface Entity { name: string; table: string; orm: string; file: string; line: number; fields: Field[] }
export interface Dep { name: string; version: string; eco: string; dev?: boolean }
export interface FileModel {
  path: string; lang: Lang; size: number; lines: number;
  symbols: CodeSymbol[]; imports: { local: string[]; external: string[] };
  routes: Route[]; entities: Entity[]; env: string[]; deps?: { deps: Dep[] };
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
}

export type AgentKind = 'claude-code' | 'codex' | 'cursor' | 'git' | 'other';
export type AgentEventType = 'prompt' | 'message' | 'thinking' | 'tool_start' | 'tool_end' | 'commit' | 'status';
export interface AgentTool { id?: string; name: string; label: string; input?: unknown; output?: string; ok?: boolean; paths: string[] }
/** `paths` and `seenAt` are set on git commit events: the root-relative files the commit changed and when LiveMap saw it. */
export interface AgentEvent { id: number; agent: AgentKind; sessionId: string; at: number; type: AgentEventType; text?: string; tool?: AgentTool; status?: 'working' | 'idle'; subagent?: boolean; paths?: string[]; seenAt?: number }
/** An event as emitted by a normalizer; the hub assigns `id`. */
export type RawAgentEvent = Omit<AgentEvent, 'id'>;
export interface AgentSession { id: string; agent: AgentKind; title: string; cwd: string; startedAt: number; lastAt: number; status: 'working' | 'idle'; transcriptPath?: string; hooks: boolean }
export interface Attribution { agent: AgentKind; sessionId: string; eventId?: number; confidence: 'exact' | 'likely'; intent?: string }
export interface Flag { id: number; target: string | null; note: string; createdAt: number; deliveredAt?: number; deliveredTo?: { agent: AgentKind; sessionId: string } }
export interface ControlState { paused: boolean; flags: Flag[] }
