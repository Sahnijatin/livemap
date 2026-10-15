import { createHash } from 'node:crypto';
import type { AgentKind, AgentTool, RawAgentEvent } from '../shared/types.js';
import { isBlockable } from '../shared/blockable.js';
import { toolLabel, toolPaths, redactSecretInput, touchesSecret, outputMentionsSecret } from './labels.js';

const MAX_OUTPUT = 4000;

export interface HookInput {
  agent: 'claude-code' | 'codex' | 'cursor';
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  root: string;
  now: number;
}
export interface NormalizedHook {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  events: RawAgentEvent[];
  blockable: boolean;
  stop: boolean;
  prompt?: string;
  /** The agent's own tool call id on tool events, when it sends one. */
  toolId?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function outputText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string | undefined;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = undefined; } }
  return s === undefined ? undefined : s.slice(0, MAX_OUTPUT);
}

/** Exit code from a tool result object (or its JSON text): `exit_code` or `exitCode`. */
function exitCode(v: unknown): number | undefined {
  let o: unknown = v;
  if (typeof v === 'string' && v.trimStart().startsWith('{')) { try { o = JSON.parse(v); } catch { return undefined; } }
  if (!isObj(o)) return undefined;
  const c = o.exit_code ?? o.exitCode;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
}
const okOf = (code: number | undefined): boolean | undefined => (code === undefined ? undefined : code === 0);

function toolEvent(
  base: { agent: AgentKind; sessionId: string; at: number }, type: 'tool_start' | 'tool_end', root: string, cwd: string | undefined,
  name: string, input: unknown, extra: { id?: string; output?: unknown; ok?: boolean },
): RawAgentEvent {
  const paths = toolPaths(name, input, root, cwd);
  const tool: AgentTool = { ...(extra.id ? { id: extra.id } : {}), name, label: toolLabel(name, input, root, cwd), paths };
  if (type === 'tool_start') tool.input = redactSecretInput(name, input);
  else {
    const text = touchesSecret(name, input, paths) ? undefined : outputText(extra.output);
    const out = text !== undefined && outputMentionsSecret(text) ? undefined : text;
    if (out !== undefined) tool.output = out;
    if (extra.ok !== undefined) tool.ok = extra.ok;
  }
  return { ...base, type, tool };
}

const idle = (base: { agent: AgentKind; sessionId: string; at: number }): RawAgentEvent => ({ ...base, type: 'status', status: 'idle' });
const sha8 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);

export function normalizeHook(input: HookInput): NormalizedHook {
  const { agent, event, root, now } = input;
  const p: Obj = isObj(input.payload) ? input.payload : {};
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const out: NormalizedHook = {
    sessionId: (agent === 'cursor' ? str(p.conversation_id) : str(p.session_id)) ?? '',
    cwd: str(p.cwd) ?? str(roots[0]) ?? root,
    events: [], blockable: isBlockable(agent, event), stop: false,
  };
  const tp = str(p.transcript_path);
  if (tp) out.transcriptPath = tp;
  const base = { agent: agent as AgentKind, sessionId: out.sessionId, at: now };
  /** Relative tool paths resolve against the agent's working directory when it says what that is. */
  const cwd = str(p.cwd) ?? str(roots[0]);
  const tool = (type: 'tool_start' | 'tool_end', n: string, inp: unknown, extra: { id?: string; output?: unknown; ok?: boolean }) =>
    out.events.push(toolEvent(base, type, root, cwd, n, inp, extra));
  const name = str(p.tool_name) ?? '';
  const toolInput = p.tool_input;
  const id = str(p.tool_use_id);
  if (id) out.toolId = id;
  const text = (type: 'prompt' | 'message' | 'thinking', t: string | undefined) => {
    if (t) out.events.push({ ...base, type, text: t });
  };

  if (agent === 'claude-code') {
    if (event === 'UserPromptSubmit') out.prompt = str(p.prompt);
    else if (event === 'Stop') { out.events.push(idle(base)); out.stop = true; }
  } else if (agent === 'codex') {
    switch (event) {
      case 'UserPromptSubmit': out.prompt = str(p.prompt); text('prompt', out.prompt); break;
      case 'PreToolUse':
        if (name) tool('tool_start', name, toolInput, { id });
        break;
      case 'PostToolUse':
        if (name) tool('tool_end', name, toolInput, { id, output: p.tool_response, ok: okOf(exitCode(p.tool_response)) });
        break;
      case 'Stop': text('message', str(p.last_assistant_message)); out.events.push(idle(base)); out.stop = true; break;
    }
  } else if (agent === 'cursor') {
    const gen = str(p.generation_id) ?? '';
    const command = str(p.command);
    const shellId = command ? `shell:${gen}:${sha8(command)}` : undefined;
    switch (event) {
      case 'beforeSubmitPrompt': out.prompt = str(p.prompt); text('prompt', out.prompt); break;
      case 'afterAgentResponse': text('message', str(p.text)); break;
      case 'afterAgentThought': text('thinking', str(p.text)); break;
      case 'preToolUse':
        if (name) tool('tool_start', name, toolInput, { id });
        break;
      case 'postToolUse':
        if (name) tool('tool_end', name, toolInput, { id, output: p.tool_output });
        break;
      case 'beforeShellExecution':
        if (command) tool('tool_start', 'Shell', { command }, { id: shellId });
        break;
      case 'afterShellExecution':
        if (command) tool('tool_end', 'Shell', { command }, { id: shellId, output: p.output, ok: okOf(exitCode(p)) });
        break;
      case 'afterFileEdit': {
        const file = str(p.file_path);
        if (file) tool('tool_end', 'Edit', { file_path: file }, { id: `edit:${gen}:${file}`, ok: true });
        break;
      }
      case 'stop': out.events.push(idle(base)); out.stop = true; break;
    }
  }
  return out;
}
