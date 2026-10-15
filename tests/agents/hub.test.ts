import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHub, transcriptKey } from '../../src/agents/hub.js';
import type { ClaudeTailer } from '../../src/agents/claude.js';
import type { AgentEvent, RawAgentEvent } from '../../src/shared/types.js';

const ROOT = '/proj';
const hubs: AgentHub[] = [];
function mk(opts: ConstructorParameters<typeof AgentHub>[1] = {}) {
  const h = new AgentHub(ROOT, opts);
  hubs.push(h);
  return h;
}
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop();
  vi.useRealTimers();
});

const codexMsg = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: text } });
const types = (h: AgentHub) => h.events().map((e) => e.type);

class FakeTailer extends EventEmitter {
  started = 0; stopped = 0; position = 0; lastActiveAt = Date.now();
  constructor(public file: string, public opts: { startOffset?: number } = {}) { super(); }
  start() { this.started++; }
  stop() { this.stopped++; }
}

describe('AgentHub codex flow', () => {
  it('prompt, tool_start, tool_end (label filled), message, status; working then idle', async () => {
    const h = mk({ readTail: async () => '' });
    const sessionStates: string[] = [];
    h.on('session', (s) => sessionStates.push(s.status));
    const T = '/t/rollout.jsonl';
    const base = { session_id: 'c1', transcript_path: T, cwd: ROOT };
    h.ingestHook('codex', 'UserPromptSubmit', { ...base, prompt: '  Add   a\n filter  ' }, 1000);
    h.ingestHook('codex', 'PreToolUse', { ...base, tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: { command: '*** Update File: src/a.ts\n' } }, 1001);
    h.ingestHook('codex', 'PostToolUse', { ...base, tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: {}, tool_response: 'ok' }, 1002);
    h.ingestHook('codex', 'Stop', { ...base, last_assistant_message: 'Done.' }, 1003);
    await h.flush();
    expect(types(h)).toEqual(['prompt', 'tool_start', 'tool_end', 'message', 'status']);
    const end = h.events()[2];
    expect(end.tool?.label).toBe(h.events()[1].tool?.label);
    expect(end.tool?.label).toBeTruthy();
    expect(end.tool?.paths).toEqual(['src/a.ts']);
    expect(h.events().map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    const [s] = h.sessions();
    expect(s).toMatchObject({ id: 'c1', agent: 'codex', title: 'Add a filter', status: 'idle', hooks: true, transcriptPath: T });
    expect(sessionStates[0]).toBe('working');
    expect(sessionStates.at(-1)).toBe('idle');
  });

  it('emits a new assistant message before tool_start and does not repeat an unchanged one', async () => {
    let tail = codexMsg('Planning the change');
    const h = mk({ readTail: async () => tail });
    const base = { session_id: 'c1', transcript_path: '/t/r.jsonl', cwd: ROOT };
    const pre = (id: string) => h.ingestHook('codex', 'PreToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'ls' } });
    pre('a'); pre('b');
    await h.flush();
    expect(types(h)).toEqual(['message', 'tool_start', 'tool_start']);
    expect(h.events()[0].text).toBe('Planning the change');
    tail = codexMsg('Now testing');
    pre('c');
    await h.flush();
    expect(types(h)).toEqual(['message', 'tool_start', 'tool_start', 'message', 'tool_start']);
  });

  it('returns the control block synchronously, before the async tail read finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = mk({ readTail: async () => { await gate; return codexMsg('hi'); } });
    h.control.setPaused(true);
    const r = h.ingestHook('codex', 'PreToolUse', { session_id: 'c1', transcript_path: '/t/r', tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'ls' } });
    expect(r.block).toMatch(/paused/);
    expect(h.events()).toEqual([]);
    h.ingestHook('codex', 'PostToolUse', { session_id: 'c1', tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'ls' }, tool_response: 'x' });
    expect(h.events()).toEqual([]);
    release();
    await h.flush();
    // The blocked start gets its synthetic failed end right after it (I1).
    expect(types(h)).toEqual(['message', 'tool_start', 'tool_end', 'tool_end']);
    expect(h.events()[2].tool?.output).toBe('Blocked by LiveMap');
  });

  it('default readTail reads the last 64 KB and returns empty on error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hub-'));
    try {
      const f = path.join(dir, 'r.jsonl');
      fs.writeFileSync(f, 'x'.repeat(200_000) + '\n' + codexMsg('from disk') + '\n');
      const h = mk();
      h.ingestHook('codex', 'PreToolUse', { session_id: 'c1', transcript_path: f, tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'ls' } });
      h.ingestHook('codex', 'PreToolUse', { session_id: 'c2', transcript_path: path.join(dir, 'missing'), tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'ls' } });
      await h.flush();
      expect(h.events().filter((e) => e.type === 'message').map((e) => e.text)).toEqual(['from disk']);
      expect(h.events().filter((e) => e.type === 'tool_start')).toHaveLength(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('AgentHub claude tailers', () => {
  it('starts one tailer per transcript across hooks; its events flow with ids; hooks emit no feed events', () => {
    const made: FakeTailer[] = [];
    const h = mk({ tailerFactory: (f) => { const t = new FakeTailer(f); made.push(t); return t as unknown as ClaudeTailer; } });
    const base = { session_id: 'k1', transcript_path: '/t/k1.jsonl', cwd: ROOT };
    for (const id of ['a', 'b', 'c']) h.ingestHook('claude-code', 'PreToolUse', { ...base, tool_name: 'Read', tool_use_id: id, tool_input: { file_path: 'x' } });
    expect(made).toHaveLength(1);
    expect(made[0].started).toBe(1);
    expect(h.events()).toEqual([]);
    const got: AgentEvent[] = [];
    h.on('event', (e) => got.push(e));
    made[0].emit('events', [
      { agent: 'claude-code', sessionId: 'k1', at: 5, type: 'prompt', text: 'Fix it' },
      { agent: 'claude-code', sessionId: 'k1', at: 6, type: 'message', text: 'ok' },
    ] satisfies RawAgentEvent[]);
    expect(got.map((e) => e.id)).toEqual([1, 2]);
    expect(h.sessions()).toHaveLength(1);
    expect(h.sessions()[0]).toMatchObject({ id: 'k1', title: 'Fix it', hooks: true, transcriptPath: '/t/k1.jsonl' });
  });

  it('transcript-only sessions get cwd = root, agent claude-code, transcriptPath = file, hooks false', () => {
    const made: FakeTailer[] = [];
    const h = mk({ tailerFactory: (f) => { const t = new FakeTailer(f); made.push(t); return t as unknown as ClaudeTailer; } });
    h.watchClaudeTranscript('/t/x.jsonl');
    h.watchClaudeTranscript('/t/x.jsonl');
    expect(made).toHaveLength(1);
    made[0].emit('events', [{ agent: 'claude-code', sessionId: 'z', at: 1, type: 'message', text: 'hi' }]);
    expect(h.sessions()[0]).toMatchObject({ id: 'z', agent: 'claude-code', cwd: ROOT, transcriptPath: '/t/x.jsonl', hooks: false, title: 'Claude Code' });
  });

  it('a tailer error never crashes; it is forwarded only when the hub has an error listener', () => {
    const made: FakeTailer[] = [];
    const h = mk({ tailerFactory: (f) => { const t = new FakeTailer(f); made.push(t); return t as unknown as ClaudeTailer; } });
    h.watchClaudeTranscript('/t/x.jsonl');
    expect(() => made[0].emit('error', new Error('boom'))).not.toThrow();
    const seen: Error[] = [];
    h.on('error', (e) => seen.push(e));
    made[0].emit('error', new Error('boom2'));
    expect(seen.map((e) => e.message)).toEqual(['boom2']);
  });

  it('stop stops tailers', () => {
    const made: FakeTailer[] = [];
    const h = mk({ tailerFactory: (f) => { const t = new FakeTailer(f); made.push(t); return t as unknown as ClaudeTailer; } });
    h.watchClaudeTranscript('/t/x.jsonl');
    h.stop();
    expect(made[0].stopped).toBe(1);
  });
});

describe('AgentHub sessions', () => {
  it('keeps separate sessions with titles and statuses; recent() spans all of them (Review Focus 3)', () => {
    const h = mk();
    const now = 100_000;
    h.ingestHook('claude-code', 'UserPromptSubmit', { session_id: 'k1', cwd: ROOT, prompt: 'Claude one' }, now - 5000);
    h.ingestHook('claude-code', 'UserPromptSubmit', { session_id: 'k2', cwd: ROOT, prompt: 'Claude two' }, now - 4000);
    h.ingestRaw([{ agent: 'claude-code', sessionId: 'k1', at: now - 3000, type: 'message', text: 'm1' }], { agent: 'claude-code', cwd: ROOT, hooks: false });
    h.ingestRaw([{ agent: 'claude-code', sessionId: 'k2', at: now - 2900, type: 'message', text: 'm2' }], { agent: 'claude-code', cwd: ROOT, hooks: false });
    h.ingestHook('cursor', 'beforeSubmitPrompt', { conversation_id: 'cu1', generation_id: 'g', prompt: 'Cursor job', workspace_roots: [ROOT] }, now - 2000);
    h.ingestHook('cursor', 'afterAgentResponse', { conversation_id: 'cu1', generation_id: 'g', text: 'cursor says' }, now - 1000);
    h.ingestHook('cursor', 'stop', { conversation_id: 'cu1', generation_id: 'g', status: 'completed' }, now - 500);
    const s = h.sessions();
    expect(s).toHaveLength(3);
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(by.k1.title).toBe('Claude one');
    expect(by.k2.title).toBe('Claude two');
    expect(by.cu1.title).toBe('Cursor job');
    expect(by.k1.status).toBe('working');
    expect(by.cu1.status).toBe('idle');
    const recent = h.recent(15_000, now);
    expect(new Set(recent.map((e) => e.sessionId))).toEqual(new Set(['k1', 'k2', 'cu1']));
    expect(new Set(h.recent(1_200, now).map((e) => e.sessionId))).toEqual(new Set(['cu1']));
  });

  it('title falls back to the agent display name, caps at 80 chars, and only the first prompt counts', () => {
    const h = mk();
    h.ingestHook('codex', 'PreToolUse', { session_id: 'c', tool_name: 'Bash', tool_input: { command: 'ls' } }, 1);
    h.ingestHook('cursor', 'afterAgentResponse', { conversation_id: 'u', text: 'x' }, 1);
    h.ingestRaw([{ agent: 'git', sessionId: 'git', at: 1, type: 'commit', text: 'abc' }], { agent: 'git', cwd: ROOT, hooks: false });
    const t = Object.fromEntries(h.sessions().map((s) => [s.id, s.title]));
    expect(t).toEqual({ c: 'Codex', u: 'Cursor', git: 'Git' });
    h.ingestHook('codex', 'UserPromptSubmit', { session_id: 'c', prompt: 'a'.repeat(200) }, 2);
    h.ingestHook('codex', 'UserPromptSubmit', { session_id: 'c', prompt: 'second' }, 3);
    expect(h.sessions().find((s) => s.id === 'c')?.title).toBe('a'.repeat(80));
  });

  it('an empty session id becomes <agent>:unknown', () => {
    const h = mk();
    h.ingestHook('codex', 'UserPromptSubmit', { prompt: 'hi' }, 1);
    expect(h.sessions()[0].id).toBe('codex:unknown');
    expect(h.events()[0].sessionId).toBe('codex:unknown');
  });

  it('ring keeps the last 2000 events and ids increase from 1', () => {
    const h = mk();
    const raw: RawAgentEvent[] = Array.from({ length: 2050 }, (_, i) => ({ agent: 'git', sessionId: 'git', at: i, type: 'commit', text: String(i) }));
    h.ingestRaw(raw, { agent: 'git', cwd: ROOT, hooks: false });
    const ev = h.events();
    expect(ev).toHaveLength(2000);
    expect(ev[0].id).toBe(51);
    expect(ev.at(-1)?.id).toBe(2050);
    expect(h.events(3).map((e) => e.id)).toEqual([2048, 2049, 2050]);
  });

  it('idle sweep marks a session idle after idleMs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = mk({ idleMs: 60_000 });
    const states: string[] = [];
    h.on('session', (s) => states.push(s.status));
    h.ingestHook('codex', 'UserPromptSubmit', { session_id: 'c', prompt: 'go' }, Date.now());
    expect(h.sessions()[0].status).toBe('working');
    vi.advanceTimersByTime(55_000);
    expect(h.sessions()[0].status).toBe('working');
    vi.advanceTimersByTime(10_000);
    expect(h.sessions()[0].status).toBe('idle');
    expect(states.at(-1)).toBe('idle');
  });

  it('stop clears the idle sweep', () => {
    vi.useFakeTimers();
    const h = mk();
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AgentHub tool handling', () => {
  const claudeTool = (h: AgentHub, evs: RawAgentEvent[]) => h.ingestRaw(evs, { agent: 'claude-code', cwd: ROOT, hooks: false });
  const start = (id: string, name: string, input: unknown, paths: string[]): RawAgentEvent => ({ agent: 'claude-code', sessionId: 's', at: 1, type: 'tool_start', tool: { id, name, label: `${name} x`, input, paths } });
  const end = (id: string, output: string): RawAgentEvent => ({ agent: 'claude-code', sessionId: 's', at: 2, type: 'tool_end', tool: { id, name: '', label: '', ok: true, output, paths: [] } });

  it('fills a tool_end from its matching start; an unmatched end keeps what it has', () => {
    const h = mk();
    claudeTool(h, [start('t1', 'Read', { file_path: 'a.ts' }, ['a.ts']), end('t1', 'body'), end('nope', 'zzz')]);
    const [, e1, e2] = h.events();
    expect(e1.tool).toMatchObject({ name: 'Read', label: 'Read x', paths: ['a.ts'], output: 'body' });
    expect(e2.tool).toMatchObject({ name: '', label: '', paths: [] });
    expect(e2.tool?.output).toBeUndefined();
  });

  it('R6: drops the output when the start touched a secret env file (path or shell command)', () => {
    const h = mk();
    claudeTool(h, [
      start('t1', 'Read', { file_path: '.env.local' }, ['.env.local']), end('t1', 'SECRET=1'),
      start('t2', 'Bash', { command: 'cat config/.env && echo hi' }, []), end('t2', 'SECRET=2'),
      start('t3', 'Bash', { command: 'cat .env.example' }, []), end('t3', 'fine'),
    ]);
    const outs = h.events().filter((e) => e.type === 'tool_end').map((e) => e.tool?.output);
    expect(outs).toEqual([undefined, undefined, 'fine']);
    expect(h.events().filter((e) => e.type === 'tool_end')[0].tool?.ok).toBe(true);
  });

  it('C1: out-of-root Read of a .env (redacted input, no root paths) drops its output', () => {
    const h = mk();
    claudeTool(h, [start('t1', 'Read', { file_path: '/elsewhere/.env' }, []), end('t1', 'API_KEY=sk-live-123')]);
    expect(JSON.stringify(h.events())).not.toContain('sk-live-123');
  });

  it('C1: an out-of-root Windows Read of a .env drops its output', () => {
    const h = mk();
    claudeTool(h, [start('w1', 'Read', { file_path: 'C:\\p\\.env' }, []), end('w1', 'API_KEY=win-123')]);
    expect(JSON.stringify(h.events())).not.toContain('win-123');
  });

  it('C1: drops any tool output that names a secret file; keeps example files', () => {
    const h = mk();
    claudeTool(h, [
      start('g1', 'Grep', { pattern: 'KEY' }, []), end('g1', 'src/a.ts:1:x\n.env:3:STRIPE_KEY=sk_live_9'),
      start('g2', 'Grep', { pattern: 'KEY' }, []), end('g2', '.env.example:1:STRIPE_KEY='),
    ]);
    const outs = h.events().filter((e) => e.type === 'tool_end').map((e) => e.tool?.output);
    expect(outs).toEqual([undefined, '.env.example:1:STRIPE_KEY=']);
  });

  it('C1: a redacted shell start (cat .env*) drops the output of its end', () => {
    const h = mk();
    claudeTool(h, [start('b1', 'Bash', { command: '<touches a secret file>' }, []), end('b1', 'K=v')]);
    expect(h.events()[1].tool?.output).toBeUndefined();
  });

  it('C1: a claude-code tool_end with an empty or missing id drops its output', () => {
    const h = mk();
    claudeTool(h, [end('', 'K=1'), { ...end('x', 'K=2'), tool: { name: '', label: '', ok: true, output: 'K=2', paths: [] } }]);
    expect(h.events().map((e) => e.tool?.output)).toEqual([undefined, undefined]);
  });

  it('C1: MultiEdit of .env via a claude hook-free transcript keeps only the path', () => {
    const h = mk();
    claudeTool(h, [start('m1', 'MultiEdit', { file_path: '/proj/.env' }, ['.env']), end('m1', 'Applied edit K=v')]);
    expect(JSON.stringify(h.events())).not.toContain('K=v');
  });

  it('R7: caps every string inside tool.input at 4000 chars (deep walk)', () => {
    const h = mk();
    const big = 'q'.repeat(9000);
    claudeTool(h, [start('t', 'Write', { content: big, nested: { arr: [big, 5, { z: big }] }, n: 3 }, [])]);
    const input = h.events()[0].tool?.input as { content: string; nested: { arr: [string, number, { z: string }] }; n: number };
    expect(input.content.length).toBe(4000);
    expect(input.nested.arr[0].length).toBe(4000);
    expect(input.nested.arr[1]).toBe(5);
    expect(input.nested.arr[2].z.length).toBe(4000);
    expect(input.n).toBe(3);
  });

  it('R8: an unmatched claude-code tool_end drops its output', () => {
    const h = mk();
    claudeTool(h, [end('gone', 'maybe secret')]);
    expect(h.events()[0].tool?.output).toBeUndefined();
  });

  it('paused + throwing session listener still returns the pause block', () => {
    const h = mk();
    h.on('session', () => { throw new Error('bad'); });
    h.control.setPaused(true);
    expect(h.ingestHook('claude-code', 'PreToolUse', { session_id: 'n', tool_name: 'Read', tool_input: {} }).block).toMatch(/paused/);
    expect(h.sessions()).toHaveLength(1);
  });

  it('pending flags + throwing event listener still returns the flag block and records later events', () => {
    const h = mk();
    h.on('event', () => { throw new Error('bad'); });
    h.control.addFlag(null, 'careful');
    const r = h.ingestHook('codex', 'PreToolUse', { session_id: 'c', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(r.block).toContain('- Project: careful');
    h.ingestRaw([{ agent: 'git', sessionId: 'g', at: 1, type: 'commit' }, { agent: 'git', sessionId: 'g', at: 2, type: 'commit' }], { agent: 'git', cwd: ROOT, hooks: false });
    // tool_start, its synthetic blocked tool_end (I1), and the two commits.
    expect(h.events()).toHaveLength(4);
  });

  it('ingestHook never throws', () => {
    const h = mk();
    h.on('event', () => { throw new Error('listener bug'); });
    expect(h.ingestHook('codex', 'UserPromptSubmit', { session_id: 'c', prompt: 'x' })).toEqual({ block: null });
    expect(() => h.ingestHook('codex', 'PreToolUse', null as never)).not.toThrow();
  });
});

describe('startDiscovery', () => {
  it('watches fresh transcripts immediately and on each tick, and stops with the hub', async () => {
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hubdisc-'));
    try {
      const pd = path.join(claude, 'projects', '-proj');
      fs.mkdirSync(pd, { recursive: true });
      const made: FakeTailer[] = [];
      const h = mk({ discoveryMs: 40, tailerFactory: (f) => { const t = new FakeTailer(f); made.push(t); return t as unknown as ClaudeTailer; } });
      fs.writeFileSync(path.join(pd, 'a.jsonl'), '{}\n');
      h.startDiscovery(claude);
      expect(made.map((t) => path.basename(t.file))).toEqual(['a.jsonl']);
      fs.writeFileSync(path.join(pd, 'b.jsonl'), '{}\n');
      await new Promise((r) => setTimeout(r, 150));
      expect(made.map((t) => path.basename(t.file)).sort()).toEqual(['a.jsonl', 'b.jsonl']);
      h.stop();
      fs.writeFileSync(path.join(pd, 'c.jsonl'), '{}\n');
      await new Promise((r) => setTimeout(r, 120));
      expect(made).toHaveLength(2);
    } finally {
      fs.rmSync(claude, { recursive: true, force: true });
    }
  });
});

describe('I1: blocked PreToolUse', () => {
  it('codex paused: tool_start then a failed tool_end with the same id and the filled label', async () => {
    const h = mk({ readTail: async () => '' });
    h.control.setPaused(true);
    const r = h.ingestHook('codex', 'PreToolUse', { session_id: 'c', transcript_path: '/t/r.jsonl', cwd: ROOT, tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: { command: '*** Update File: src/a.ts' } }, 1000);
    expect(r.block).toMatch(/paused/);
    await h.flush();
    const [s, e] = h.events();
    expect(h.events().map((x) => x.type)).toEqual(['tool_start', 'tool_end']);
    expect(e.tool).toMatchObject({ id: 'u1', ok: false, output: 'Blocked by LiveMap', label: s.tool!.label, paths: ['src/a.ts'] });
    expect(e.at).toBe(1000);
    expect(h.isBlocked('c', 'u1')).toBe(true);
  });

  it('cursor beforeShellExecution with pending flags: start and failed end share the shell id', () => {
    const h = mk();
    h.control.addFlag(null, 'stop');
    h.ingestHook('cursor', 'beforeShellExecution', { conversation_id: 'k', generation_id: 'g', command: 'rm -rf build' }, 5);
    const [s, e] = h.events();
    expect(s.type).toBe('tool_start');
    expect(e).toMatchObject({ type: 'tool_end', tool: { id: s.tool!.id, ok: false, output: 'Blocked by LiveMap', label: '$ rm -rf build' } });
  });

  it('a start without an id gets a generated blocked id on both events', () => {
    const h = mk();
    h.control.setPaused(true);
    h.ingestHook('cursor', 'preToolUse', { conversation_id: 'k', tool_name: 'Write', tool_input: { file_path: 'a.ts' } }, 7);
    const [s, e] = h.events();
    expect(s.tool!.id).toBe('blocked:k:7:0');
    expect(e.tool!.id).toBe('blocked:k:7:0');
  });

  it('claude PreToolUse adds no events (Claude Code writes its own error result) but marks the id blocked', () => {
    const h = mk({ tailerFactory: (f) => new FakeTailer(f) as unknown as ClaudeTailer });
    h.control.setPaused(true);
    h.ingestHook('claude-code', 'PreToolUse', { session_id: 'q', tool_name: 'Edit', tool_use_id: 'tu', tool_input: { file_path: '/proj/a.ts' } });
    expect(h.events()).toEqual([]);
    expect(h.isBlocked('q', 'tu')).toBe(true);
    expect(h.isBlocked('q', 'other')).toBe(false);
  });

  it('not blocked: no synthetic end', () => {
    const h = mk();
    h.ingestHook('cursor', 'beforeShellExecution', { conversation_id: 'k', generation_id: 'g', command: 'ls' });
    expect(h.events().map((e) => e.type)).toEqual(['tool_start']);
  });
});

describe('M1: hook decisions that never reach the agent', () => {
  it('ingestHook with canBlock false records events but neither blocks nor consumes flags', () => {
    const h = mk();
    h.control.addFlag(null, 'later');
    const r = h.ingestHook('codex', 'PreToolUse', { session_id: 'c', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'ls' } }, 1, { canBlock: false });
    expect(r.block).toBeNull();
    expect(h.control.state().flags[0].deliveredAt).toBeUndefined();
    expect(h.events().map((e) => e.type)).toEqual(['tool_start']);
  });
  it('ingestHook returns the ids of the flags it delivered', () => {
    const h = mk();
    const f = h.control.addFlag(null, 'now');
    expect(h.ingestHook('codex', 'PreToolUse', { session_id: 'c', tool_name: 'Bash', tool_input: { command: 'ls' } }, 1).flags).toEqual([f.id]);
  });
});

describe('I2: session lastAt updates', () => {
  it('re-broadcasts the session when lastAt advances, at most once per 5 s', () => {
    const h = mk();
    const seen: number[] = [];
    h.on('session', (s) => seen.push(s.lastAt));
    const msg = (at: number): RawAgentEvent => ({ agent: 'claude-code', sessionId: 's', at, type: 'message', text: 'x' });
    for (const at of [1000, 2000, 7000, 8000, 12_500]) h.ingestRaw([msg(at)], { agent: 'claude-code', cwd: ROOT, hooks: false });
    expect(seen).toEqual([1000, 7000, 12_500]);
    expect(h.sessions()[0].lastAt).toBe(12_500);
  });

  it('a hook bumps lastAt even when it adds no events, and a hooks change is broadcast', () => {
    const h = mk({ tailerFactory: (f) => new FakeTailer(f) as unknown as ClaudeTailer });
    h.ingestRaw([{ agent: 'claude-code', sessionId: 'q', at: 1000, type: 'message', text: 'x' }], { agent: 'claude-code', cwd: ROOT, hooks: false });
    const seen: { lastAt: number; hooks: boolean; transcriptPath?: string }[] = [];
    h.on('session', (s) => seen.push(s));
    h.ingestHook('claude-code', 'PreToolUse', { session_id: 'q', transcript_path: '/t/q.jsonl', tool_name: 'Read', tool_input: {} }, 2000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hooks: true, lastAt: 2000, transcriptPath: '/t/q.jsonl' });
    h.ingestHook('claude-code', 'PreToolUse', { session_id: 'q', tool_name: 'Read', tool_input: {} }, 9000);
    expect(h.sessions()[0].lastAt).toBe(9000);
    expect(seen.at(-1)!.lastAt).toBe(9000);
  });
});

describe('M3 and M6: idle sweep and text caps', () => {
  it('the idle sweep leaves a session with an open tool_start working', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = mk({ idleMs: 60_000 });
    const raw = (type: 'tool_start' | 'tool_end'): RawAgentEvent => ({ agent: 'claude-code', sessionId: 's', at: Date.now(), type, tool: { id: 't', name: 'Bash', label: '$ sleep', paths: [] } });
    h.ingestRaw([raw('tool_start')], { agent: 'claude-code', cwd: ROOT, hooks: false });
    vi.advanceTimersByTime(120_000);
    expect(h.sessions()[0].status).toBe('working');
    h.ingestRaw([raw('tool_end')], { agent: 'claude-code', cwd: ROOT, hooks: false });
    vi.advanceTimersByTime(65_000);
    expect(h.sessions()[0].status).toBe('idle');
  });

  it('caps prompt, message and thinking text at 64 KB', () => {
    const h = mk();
    const big = 'w'.repeat(200_000);
    h.ingestRaw((['prompt', 'message', 'thinking'] as const).map((type, i) => ({ agent: 'codex', sessionId: 'c', at: i, type, text: big })), { agent: 'codex', cwd: ROOT, hooks: true });
    for (const e of h.events()) expect(e.text!.length).toBe(65_536);
  });
});

describe('I4: tailer lifetime', () => {
  it('keys tailers by realpath so a symlinked spelling reuses the same tailer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hub-'));
    try {
      const file = path.join(dir, 't.jsonl');
      fs.writeFileSync(file, '');
      fs.symlinkSync(file, path.join(dir, 'link.jsonl'));
      const made: FakeTailer[] = [];
      const h = mk({ tailerFactory: (f) => { const t = new FakeTailer(f); made.push(t); return t as unknown as ClaudeTailer; } });
      h.watchClaudeTranscript(file);
      h.watchClaudeTranscript(path.join(dir, 'link.jsonl'));
      h.watchClaudeTranscript(path.join(dir, '.', 't.jsonl'));
      expect(made).toHaveLength(1);
      expect(made[0].file).toBe(fs.realpathSync(file));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('evicts a tailer idle for 30 min and resumes at its saved offset without backfill', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const made: FakeTailer[] = [];
    const h = mk({ tailerFactory: (f, o) => { const t = new FakeTailer(f, o); made.push(t); return t as unknown as ClaudeTailer; } });
    h.watchClaudeTranscript('/t/x.jsonl');
    expect(made[0].opts.startOffset).toBeUndefined();
    made[0].position = 4242;
    vi.advanceTimersByTime(29 * 60_000);
    expect(made[0].stopped).toBe(0);
    made[0].lastActiveAt = Date.now();
    vi.advanceTimersByTime(29 * 60_000);
    expect(made[0].stopped).toBe(0);
    vi.advanceTimersByTime(2 * 60_000);
    expect(made[0].stopped).toBe(1);
    h.watchClaudeTranscript('/t/x.jsonl');
    expect(made).toHaveLength(2);
    expect(made[1].opts.startOffset).toBe(4242);
    expect(made[1].started).toBe(1);
  });
});

describe('review fixes: session status', () => {
  const ev = (type: RawAgentEvent['type'], at: number, extra: Partial<RawAgentEvent> = {}): RawAgentEvent =>
    ({ agent: 'claude-code', sessionId: 's', at, type, ...extra } as RawAgentEvent);
  const hints = { agent: 'claude-code' as const, cwd: ROOT, hooks: true };

  it('a transcript event older than the idle status does not flip a finished session back to working', () => {
    const h = mk();
    h.ingestRaw([ev('message', 1000, { text: 'Done.' })], hints);
    h.ingestRaw([ev('status', 1100, { status: 'idle' } as Partial<RawAgentEvent>)], hints);
    h.ingestRaw([ev('message', 1000, { text: 'Done.' })], hints); // the tailer catches up late
    expect(h.sessions()[0].status).toBe('idle');
    h.ingestRaw([ev('prompt', 2000, { text: 'next' })], hints);
    expect(h.sessions()[0].status).toBe('working');
  });

  it('a tool that never reports an end stops counting as running after 10 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = mk({ idleMs: 60_000 });
    h.ingestRaw([ev('tool_start', Date.now(), { tool: { id: 't', name: 'Bash', label: '$ x', paths: [] } })], { ...hints, hooks: false });
    vi.advanceTimersByTime(9 * 60_000);
    expect(h.sessions()[0].status).toBe('working');
    vi.advanceTimersByTime(2 * 60_000);
    expect(h.sessions()[0].status).toBe('idle');
  });
});

describe('review fixes: transcript keys', () => {
  it('a transcript that does not exist yet gets the same key as once it exists, through a symlinked dir', () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-tk-')));
    const link = `${real}-link`;
    try {
      fs.mkdirSync(path.join(real, 'projects'));
      fs.symlinkSync(real, link);
      const viaLink = path.join(link, 'projects', 's.jsonl');
      const before = transcriptKey(viaLink);
      fs.writeFileSync(path.join(real, 'projects', 's.jsonl'), '');
      expect(transcriptKey(viaLink)).toBe(before);
      expect(transcriptKey(path.join(real, 'projects', 's.jsonl'))).toBe(before);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});


describe('#49: tool classification across start and end', () => {
  it('a codex MCP tool_execute keeps its inner tool, access and targets on the end, plus sys_ids from the result', async () => {
    const h = mk({ readTail: async () => '' });
    const base = { session_id: 'c9', transcript_path: '/t/r9', cwd: ROOT };
    const SYS_ID = '871f6b2a1b2c3d4e5f60718293a4b5c6';
    h.ingestHook('codex', 'PreToolUse', { ...base, tool_name: 'mcp__skyforge-nexus__tool_execute', tool_use_id: 'm1', tool_input: { tool: 'sn_record_manage', args: { table: 'sys_script', action: 'create', name: 'Set offer' } } }, 1000);
    h.ingestHook('codex', 'PostToolUse', { ...base, tool_name: 'mcp__skyforge-nexus__tool_execute', tool_use_id: 'm1', tool_input: {}, tool_response: JSON.stringify({ success: true, data: { sys_id: SYS_ID } }) }, 1001);
    await h.flush();
    const [start, end] = h.events().filter((e) => e.tool);
    expect(start.tool).toMatchObject({ inner: 'sn_record_manage', access: 'write', label: 'sn_record_manage create sys_script Set offer' });
    expect(end.tool).toMatchObject({ inner: 'sn_record_manage', access: 'write' });
    expect(end.tool?.targets).toEqual([
      { kind: 'record', instance: '', table: 'sys_script', name: 'Set offer' },
      { kind: 'record', instance: '', table: 'sys_script', name: 'Set offer', sysId: SYS_ID },
    ]);
  });
});
