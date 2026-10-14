import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeHook, type HookInput } from '../../src/agents/normalize.js';
import { lastCodexAssistantText } from '../../src/agents/codex.js';

const DIR = path.join(__dirname, '../fixtures/agents/hooks');
const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8'));
const NOW = 1_700_000_000_000;
const run = (agent: HookInput['agent'], event: string, name: string, payload?: unknown) =>
  normalizeHook({ agent, event, payload: payload === undefined ? fx(name) : payload, root: '/p', now: NOW });

describe('normalizeHook claude-code', () => {
  it('PreToolUse is blockable and yields no events', () => {
    const r = run('claude-code', 'PreToolUse', 'claude-PreToolUse');
    expect(r).toMatchObject({ sessionId: 'cc-1', cwd: '/p', transcriptPath: '/home/u/.claude/projects/p/cc-1.jsonl', events: [], blockable: true, stop: false });
  });
  it('UserPromptSubmit and SessionStart yield no events; prompt text is exposed', () => {
    const u = run('claude-code', 'UserPromptSubmit', 'claude-UserPromptSubmit');
    expect(u).toMatchObject({ events: [], blockable: false, stop: false, prompt: 'add a login page' });
    const s = run('claude-code', 'SessionStart', 'claude-SessionStart');
    expect(s).toMatchObject({ events: [], blockable: false, stop: false });
    expect(s.prompt).toBeUndefined();
  });
  it('Stop yields status idle and stop', () => {
    const r = run('claude-code', 'Stop', 'claude-Stop');
    expect(r.stop).toBe(true);
    expect(r.blockable).toBe(false);
    expect(r.events).toEqual([{ agent: 'claude-code', sessionId: 'cc-1', at: NOW, type: 'status', status: 'idle' }]);
  });
});

describe('normalizeHook codex', () => {
  it('UserPromptSubmit yields a prompt', () => {
    const r = run('codex', 'UserPromptSubmit', 'codex-UserPromptSubmit');
    expect(r.events).toEqual([{ agent: 'codex', sessionId: 'cx-1', at: NOW, type: 'prompt', text: 'fix the bug' }]);
    expect(r.prompt).toBe('fix the bug');
    expect(r.blockable).toBe(false);
  });
  it('PreToolUse yields tool_start with id and is blockable', () => {
    const r = run('codex', 'PreToolUse', 'codex-PreToolUse');
    expect(r.blockable).toBe(true);
    expect(r.events).toEqual([{ agent: 'codex', sessionId: 'cx-1', at: NOW, type: 'tool_start', tool: { id: 'call_1', name: 'Bash', label: '$ npm test', input: { command: 'npm test' }, paths: [] } }]);
  });
  it('apply_patch PreToolUse takes paths and label from the patch', () => {
    const t = run('codex', 'PreToolUse', 'codex-PreToolUse-patch').events[0].tool!;
    expect(t.paths).toEqual(['src/x.ts']);
    expect(t.label).toBe('Patch src/x.ts');
  });
  it('PostToolUse yields tool_end with output', () => {
    const r = run('codex', 'PostToolUse', 'codex-PostToolUse');
    expect(r.blockable).toBe(false);
    expect(r.events).toEqual([{ agent: 'codex', sessionId: 'cx-1', at: NOW, type: 'tool_end', tool: { id: 'call_1', name: 'Bash', label: '$ npm test', output: '3 passed', paths: [] } }]);
  });
  it('PostToolUse JSON-encodes object responses', () => {
    const p = { ...fx('codex-PostToolUse'), tool_response: { exit: 0 } };
    expect(run('codex', 'PostToolUse', '', p).events[0].tool!.output).toBe('{"exit":0}');
  });
  it('Stop yields message then idle', () => {
    const r = run('codex', 'Stop', 'codex-Stop');
    expect(r.stop).toBe(true);
    expect(r.events).toEqual([
      { agent: 'codex', sessionId: 'cx-1', at: NOW, type: 'message', text: 'Done, tests pass.' },
      { agent: 'codex', sessionId: 'cx-1', at: NOW, type: 'status', status: 'idle' },
    ]);
  });
  it('Stop without last_assistant_message yields only idle', () => {
    const { last_assistant_message: _, ...p } = fx('codex-Stop');
    expect(run('codex', 'Stop', '', p).events.map((e) => e.type)).toEqual(['status']);
  });
});

describe('normalizeHook cursor', () => {
  const base = { agent: 'cursor' as const, sessionId: 'cu-1', at: NOW };
  it('prompt, response, thought', () => {
    const p = run('cursor', 'beforeSubmitPrompt', 'cursor-beforeSubmitPrompt');
    expect(p.events).toEqual([{ ...base, type: 'prompt', text: 'refactor the cart' }]);
    expect(p.prompt).toBe('refactor the cart');
    expect(p.cwd).toBe('/p');
    expect(run('cursor', 'afterAgentResponse', 'cursor-afterAgentResponse').events).toEqual([{ ...base, type: 'message', text: 'I refactored it.' }]);
    expect(run('cursor', 'afterAgentThought', 'cursor-afterAgentThought').events).toEqual([{ ...base, type: 'thinking', text: 'Considering options' }]);
  });
  it('preToolUse and postToolUse', () => {
    const pre = run('cursor', 'preToolUse', 'cursor-preToolUse');
    expect(pre.blockable).toBe(true);
    expect(pre.events).toEqual([{ ...base, type: 'tool_start', tool: { id: 'tu_1', name: 'Read', label: 'Read src/a.ts', input: { file_path: '/p/src/a.ts' }, paths: ['src/a.ts'] } }]);
    const post = run('cursor', 'postToolUse', 'cursor-postToolUse');
    expect(post.blockable).toBe(false);
    expect(post.events).toEqual([{ ...base, type: 'tool_end', tool: { id: 'tu_1', name: 'Read', label: 'Read src/a.ts', output: '{"content":"hello"}', paths: ['src/a.ts'] } }]);
  });
  it('shell before/after share a synthetic id', () => {
    const id = 'shell:gen-1:' + createHash('sha1').update('ls -la').digest('hex').slice(0, 8);
    const b = run('cursor', 'beforeShellExecution', 'cursor-beforeShellExecution');
    expect(b.blockable).toBe(true);
    expect(b.events).toEqual([{ ...base, type: 'tool_start', tool: { id, name: 'Shell', label: '$ ls -la', input: { command: 'ls -la' }, paths: [] } }]);
    const a = run('cursor', 'afterShellExecution', 'cursor-afterShellExecution');
    expect(a.blockable).toBe(false);
    expect(a.events).toEqual([{ ...base, type: 'tool_end', tool: { id, name: 'Shell', label: '$ ls -la', output: 'total 0', paths: [] } }]);
  });
  it('afterFileEdit is a synthetic Edit tool_end', () => {
    const r = run('cursor', 'afterFileEdit', 'cursor-afterFileEdit');
    expect(r.events).toEqual([{ ...base, type: 'tool_end', tool: { id: 'edit:gen-1:/p/src/a.ts', name: 'Edit', label: 'Edit src/a.ts', ok: true, paths: ['src/a.ts'] } }]);
  });
  it('stop yields idle', () => {
    const r = run('cursor', 'stop', 'cursor-stop');
    expect(r.stop).toBe(true);
    expect(r.events).toEqual([{ ...base, type: 'status', status: 'idle' }]);
  });
});

describe('robustness and safety', () => {
  it('truncates a 2 MB tool_response to 4,000 chars', () => {
    const p = { ...fx('codex-PostToolUse'), tool_response: 'x'.repeat(2 * 1024 * 1024) };
    expect(run('codex', 'PostToolUse', '', p).events[0].tool!.output!.length).toBeLessThanOrEqual(4000);
  });
  it('does not throw on an empty payload or unknown event/agent', () => {
    for (const agent of ['claude-code', 'codex', 'cursor'] as const) {
      expect(() => run(agent, 'Whatever', '', {})).not.toThrow();
      expect(run(agent, 'Whatever', '', {})).toMatchObject({ events: [], blockable: false, stop: false, cwd: '/p' });
      for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'preToolUse', 'afterFileEdit', 'beforeShellExecution']) expect(() => run(agent, ev, '', {})).not.toThrow();
    }
    expect(run('git' as never, 'x', '', null).events).toEqual([]);
  });
  it('falls back cwd to workspace_roots[0] then root', () => {
    expect(run('cursor', 'stop', '', { conversation_id: 'c', workspace_roots: ['/w'] }).cwd).toBe('/w');
    expect(run('cursor', 'stop', '', { conversation_id: 'c' }).cwd).toBe('/p');
  });
  it('drops output when a tool touches a secret env file', () => {
    const post = (tool_name: string, tool_input: unknown) =>
      run('codex', 'PostToolUse', '', { ...fx('codex-PostToolUse'), tool_name, tool_input, tool_response: 'SECRET=1' }).events[0].tool!;
    const t = post('Read', { file_path: '/p/.env' });
    expect(t.output).toBeUndefined();
    expect(t.paths).toEqual(['.env']);
    expect(post('Bash', { command: 'cat .env.local' }).output).toBeUndefined();
    expect(post('Bash', { command: 'cat "/p/config/.env"' }).output).toBeUndefined();
    expect(post('Read', { file_path: '/p/.env.example' }).output).toBe('SECRET=1');
    const cu = run('cursor', 'afterShellExecution', '', { conversation_id: 'c', generation_id: 'g', command: 'cat .env', output: 'K=v' }).events[0].tool!;
    expect(cu.output).toBeUndefined();
  });
  it('redacts secret file inputs on tool_start', () => {
    const t = run('codex', 'PreToolUse', '', { ...fx('codex-PreToolUse'), tool_name: 'Write', tool_input: { file_path: '/p/.env', content: 'K=v' } }).events[0].tool!;
    expect(t.input).toEqual({ file_path: '/p/.env' });
  });
});

describe('C1: secrets never reach events', () => {
  const codexPost = (tool_name: string, tool_input: unknown, tool_response: unknown) =>
    run('codex', 'PostToolUse', '', { ...fx('codex-PostToolUse'), tool_name, tool_input, tool_response }).events[0].tool!;
  it('drops grep output that names a secret file', () => {
    expect(codexPost('Grep', { pattern: 'KEY' }, '.env:3:STRIPE_KEY=sk_live_1').output).toBeUndefined();
    expect(codexPost('Grep', { pattern: 'KEY' }, 'src/a.ts:1:KEY').output).toBe('src/a.ts:1:KEY');
  });
  it('shell commands naming .env (globs too) keep neither value nor command', () => {
    const start = run('codex', 'PreToolUse', '', { ...fx('codex-PreToolUse'), tool_name: 'Bash', tool_input: { command: 'echo K=v >> .env' } }).events[0].tool!;
    expect(start.input).toEqual({ command: '<touches a secret file>' });
    expect(start.label).toBe('$ (command touching .env)');
    const end = codexPost('Bash', { command: 'cat .env*' }, 'K=v');
    expect(end.output).toBeUndefined();
    expect(JSON.stringify(end)).not.toContain('K=v');
    expect(end.label).toBe('$ (command touching .env)');
  });
  it('apply_patch PostToolUse touching .env drops its output', () => {
    const t = codexPost('apply_patch', { command: '*** Begin Patch\n*** Update File: .env\n+K=v\n*** End Patch' }, 'Success. Updated .env with K=v');
    expect(t.output).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain('K=v');
  });
  it('cursor postToolUse Read of .env drops its output', () => {
    const t = run('cursor', 'postToolUse', '', { conversation_id: 'c', generation_id: 'g', tool_name: 'Read', tool_input: { target_file: '.env' }, tool_output: '{"contents":"API_KEY=1"}', tool_use_id: 'r1' }).events[0].tool!;
    expect(t.output).toBeUndefined();
  });
  it('out-of-root Read of a .env drops its output; .envrc.local edits keep only the path', () => {
    expect(codexPost('Read', { file_path: '/elsewhere/.env' }, 'API_KEY=sk-live-123').output).toBeUndefined();
    const s = run('codex', 'PreToolUse', '', { ...fx('codex-PreToolUse'), tool_name: 'Edit', tool_input: { file_path: '/p/.envrc.local', old_string: 'A=1', new_string: 'A=2' } }).events[0].tool!;
    expect(s.input).toEqual({ file_path: '/p/.envrc.local' });
  });
  it('Windows: backslash grep output and PowerShell reads of .env keep no values', () => {
    expect(codexPost('Grep', { pattern: 'WK' }, 'config\\.env:3:WK=v').output).toBeUndefined();
    for (const command of ['type ..\\.env', 'Get-Content .\\.env']) {
      const t = codexPost('Bash', { command }, 'WK=v');
      expect(t.output, command).toBeUndefined();
      expect(JSON.stringify(t), command).not.toContain('WK=v');
    }
  });
  it('M4: relative tool paths resolve against the payload cwd', () => {
    const t = run('codex', 'PreToolUse', '', { ...fx('codex-PreToolUse'), cwd: '/p/apps/web', tool_name: 'apply_patch', tool_input: { command: '*** Update File: src/a.ts' } }).events[0].tool!;
    expect(t.paths).toEqual(['apps/web/src/a.ts']);
  });
});

describe('M8: codex and cursor tool results carry ok when known', () => {
  it('codex exit_code !== 0 is a failure; exit_code 0 is ok; otherwise ok stays unknown', () => {
    const post = (tool_response: unknown) => run('codex', 'PostToolUse', '', { ...fx('codex-PostToolUse'), tool_response }).events[0].tool!;
    expect(post({ exit_code: 1, output: 'boom' }).ok).toBe(false);
    expect(post({ exit_code: 0, output: 'fine' }).ok).toBe(true);
    expect(post('plain text').ok).toBeUndefined();
  });
  it('cursor afterShellExecution exit code maps to ok', () => {
    const after = (extra: object) => run('cursor', 'afterShellExecution', '', { conversation_id: 'c', generation_id: 'g', command: 'ls', output: 'x', ...extra }).events[0].tool!;
    expect(after({ exit_code: 2 }).ok).toBe(false);
    expect(after({ exitCode: 0 }).ok).toBe(true);
    expect(after({}).ok).toBeUndefined();
  });
});

describe('lastCodexAssistantText', () => {
  const rollout = fs.readFileSync(path.join(__dirname, '../fixtures/agents/codex-rollout.jsonl'), 'utf8');
  it('returns the later of the assistant message and agent_message', () => {
    expect(lastCodexAssistantText(rollout)).toBe('Patched the bug.');
  });
  it('prefers a later response_item message', () => {
    const extra = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }, { type: 'input_text', text: 'z' }] } });
    expect(lastCodexAssistantText(rollout + 'garbage\n' + extra + '\n')).toBe('ab');
  });
  it('returns null when nothing matches', () => {
    expect(lastCodexAssistantText('not json\n{"type":"x"}\n')).toBeNull();
    expect(lastCodexAssistantText('')).toBeNull();
  });
});
