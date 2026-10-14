import { describe, it, expect, afterEach } from 'vitest';
import { AgentHub } from '../../src/agents/hub.js';
import { Attributor } from '../../src/agents/attribution.js';
import type { Attribution, ChangeSummary, RawAgentEvent } from '../../src/shared/types.js';

const T0 = 1_000_000;
const hints = { agent: 'claude-code' as const, cwd: '/proj', hooks: true };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function setup() {
  const hub = new AgentHub('/proj');
  const attr = new Attributor(hub);
  cleanup.push(() => { attr.stop(); hub.stop(); });
  const feed = (...evs: RawAgentEvent[]) => hub.ingestRaw(evs, hints);
  return { hub, attr, feed };
}
const change = (over: Partial<ChangeSummary> = {}): ChangeSummary => ({ id: 1, path: 'src/a.ts', kind: 'modified', at: T0, ...over }) as ChangeSummary;
const ev = (sessionId: string, type: RawAgentEvent['type'], at: number, extra: Partial<RawAgentEvent> = {}): RawAgentEvent => ({ agent: 'claude-code', sessionId, at, type, ...extra });
const tool = (sessionId: string, name: string, at: number, paths: string[], type: 'tool_start' | 'tool_end' = 'tool_start'): RawAgentEvent =>
  ev(sessionId, type, at, { tool: { id: `${sessionId}${at}${name}`, name, label: name, paths } });

describe('Attributor', () => {
  it('exact from an Edit on the file 2 s before; intent is the preceding message', () => {
    const { attr, feed } = setup();
    feed(ev('S', 'prompt', T0 - 9000, { text: 'do it' }), ev('S', 'message', T0 - 3000, { text: 'Adding a filter' }), tool('S', 'Edit', T0 - 2000, ['src/a.ts']));
    const a = attr.attribute(change(), T0);
    expect(a).toMatchObject({ agent: 'claude-code', sessionId: 'S', confidence: 'exact', intent: 'Adding a filter' });
    expect(a?.eventId).toBeTypeOf('number');
  });

  it('likely from a Bash event with no paths 5 s earlier', () => {
    const { attr, feed } = setup();
    feed(tool('S', 'Bash', T0 - 5000, []));
    expect(attr.attribute(change(), T0)).toMatchObject({ sessionId: 'S', confidence: 'likely' });
  });

  it('undefined with no events in the last 15 s', () => {
    const { attr, feed } = setup();
    feed(tool('S', 'Edit', T0 - 16000, ['src/a.ts']));
    expect(attr.attribute(change(), T0)).toBeUndefined();
  });

  it('a Read event on the file 1 s before does not make it exact', () => {
    const { attr, feed } = setup();
    feed(tool('S', 'Read', T0 - 1000, ['src/a.ts']));
    expect(attr.attribute(change(), T0)?.confidence).toBe('likely');
  });

  it('git commit events never count as likely', () => {
    const { attr, feed } = setup();
    feed({ agent: 'git', sessionId: 'git', at: T0 - 1000, type: 'commit', text: 'x' });
    expect(attr.attribute(change(), T0)).toBeUndefined();
  });

  it('two sessions: only B touched the file, so B wins even though A is newer', () => {
    const { attr, feed } = setup();
    feed(tool('B', 'Write', T0 - 4000, ['src/a.ts']), tool('A', 'Edit', T0 - 500, ['src/other.ts']));
    expect(attr.attribute(change(), T0)).toMatchObject({ sessionId: 'B', confidence: 'exact' });
  });

  it('likely picks the most recently active session', () => {
    const { attr, feed } = setup();
    feed(tool('A', 'Bash', T0 - 6000, []), tool('B', 'Bash', T0 - 2000, []));
    expect(attr.attribute(change(), T0)?.sessionId).toBe('B');
  });

  it('a message older than the last prompt is not the intent; falls back to Asked: prompt', () => {
    const { attr, feed } = setup();
    feed(ev('S', 'message', T0 - 8000, { text: 'old reply' }), ev('S', 'prompt', T0 - 6000, { text: 'new ask' }), tool('S', 'Edit', T0 - 1000, ['src/a.ts']));
    expect(attr.attribute(change(), T0)?.intent).toBe('Asked: new ask');
  });

  it('an older message ingested after the new prompt is not the intent', () => {
    const { attr, feed } = setup();
    feed(ev('S', 'prompt', T0 - 6000, { text: 'new ask' }), ev('S', 'message', T0 - 8000, { text: 'old reply' }), tool('S', 'Edit', T0 - 1000, ['src/a.ts']));
    expect(attr.attribute(change(), T0)?.intent).toBe('Asked: new ask');
  });

  it('a throwing late listener does not propagate', () => {
    const { attr, feed } = setup();
    attr.on('late', () => { throw new Error('boom'); });
    attr.attribute(change(), T0);
    expect(() => feed(tool('S', 'Edit', T0 + 1000, ['src/a.ts']))).not.toThrow();
  });

  it('finds the prompt for long turns beyond the window and caps intent at 500 chars', () => {
    const { attr, feed } = setup();
    feed(ev('S', 'prompt', T0 - 600_000, { text: 'x'.repeat(900) }), tool('S', 'Edit', T0 - 1000, ['src/a.ts']));
    const i = attr.attribute(change(), T0)?.intent as string;
    expect(i.length).toBe(500);
    expect(i.startsWith('Asked: ')).toBe(true);
  });

  it('late write-family event 3 s after emits late exact; 7 s after does not; once only', () => {
    const { attr, feed } = setup();
    const got: Array<[number, Attribution]> = [];
    attr.on('late', (id, a) => got.push([id, a]));
    expect(attr.attribute(change(), T0)).toBeUndefined();
    feed(tool('S', 'Edit', T0 + 7000, ['src/a.ts']));
    expect(got).toHaveLength(0);
    attr.attribute(change({ id: 2, at: T0 + 20_000 }), T0 + 20_000);
    feed(tool('S', 'Edit', T0 + 23_000, ['src/a.ts']), tool('S', 'Edit', T0 + 23_500, ['src/a.ts'], 'tool_end'));
    expect(got).toHaveLength(1);
    expect(got[0][0]).toBe(2);
    expect(got[0][1]).toMatchObject({ sessionId: 'S', confidence: 'exact' });
  });

  it('late event upgrades a likely change; Read does not', () => {
    const { attr, feed } = setup();
    const got: number[] = [];
    attr.on('late', (id) => got.push(id));
    feed(tool('S', 'Bash', T0 - 1000, []));
    expect(attr.attribute(change(), T0)?.confidence).toBe('likely');
    feed(tool('S', 'Read', T0 + 1000, ['src/a.ts']));
    expect(got).toEqual([]);
    feed(tool('S', 'MultiEdit', T0 + 2000, ['src/a.ts']));
    expect(got).toEqual([1]);
  });

  it('stop removes the hub listener', () => {
    const { hub, attr, feed } = setup();
    const before = hub.listenerCount('event');
    attr.stop();
    expect(hub.listenerCount('event')).toBe(before - 1);
    const got: number[] = [];
    attr.on('late', (id) => got.push(id));
    feed(tool('S', 'Edit', T0 + 1000, ['src/a.ts']));
    expect(got).toEqual([]);
  });

  it('I1: a blocked codex apply_patch followed by a manual edit within 10 s is not exact', () => {
    const { hub, attr } = setup();
    hub.control.setPaused(true);
    hub.ingestHook('codex', 'PreToolUse', { session_id: 'C', cwd: '/proj', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { command: '*** Update File: src/a.ts' } }, T0 - 2000);
    const a = attr.attribute(change(), T0);
    expect(a?.confidence).not.toBe('exact');
  });

  it('I1: a blocked tool arriving after the change does not back-fill it', () => {
    const { hub, attr } = setup();
    const got: number[] = [];
    attr.on('late', (id) => got.push(id));
    expect(attr.attribute(change(), T0)).toBeUndefined();
    hub.control.setPaused(true);
    hub.ingestHook('cursor', 'preToolUse', { conversation_id: 'K', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: '/proj/src/a.ts' } }, T0 + 1000);
    expect(got).toEqual([]);
  });

  it('I1: a claude tool_use whose PreToolUse was blocked is ignored', () => {
    const { hub, attr, feed } = setup();
    hub.control.setPaused(true);
    hub.ingestHook('claude-code', 'PreToolUse', { session_id: 'S', tool_name: 'Edit', tool_use_id: 'tb', tool_input: { file_path: '/proj/src/a.ts' } }, T0 - 1500);
    feed(ev('S', 'tool_start', T0 - 1400, { tool: { id: 'tb', name: 'Edit', label: 'Edit', paths: ['src/a.ts'] } }));
    expect(attr.attribute(change(), T0)?.confidence).not.toBe('exact');
  });

  const commitEv = (at: number, seenAt: number, paths: string[], text = 'Add filter\n\nbody'): RawAgentEvent =>
    ({ agent: 'git', sessionId: 'Ann', at, seenAt, type: 'commit', text, paths });
  const gitHints = { agent: 'git' as const, cwd: '/proj', hooks: false };

  it('I5: a commit seen within the window that lists the file is an exact git attribution', () => {
    const { hub, attr } = setup();
    hub.ingestRaw([commitEv(T0 - 600_000, T0 - 1000, ['src/a.ts', 'b.ts'])], gitHints);
    const a = attr.attribute(change(), T0);
    expect(a).toMatchObject({ agent: 'git', sessionId: 'Ann', confidence: 'exact', intent: 'Add filter' });
    expect(a?.eventId).toBeTypeOf('number');
  });

  it('I5: a commit not listing the file, or seen outside the window, does not count', () => {
    const { hub, attr } = setup();
    hub.ingestRaw([commitEv(T0, T0, ['other.ts']), commitEv(T0, T0 - 60_000, ['src/a.ts'])], gitHints);
    expect(attr.attribute(change(), T0)).toBeUndefined();
  });

  it('I5: a commit seen after the change back-fills it as exact', () => {
    const { hub, attr } = setup();
    const got: Array<[number, Attribution]> = [];
    attr.on('late', (id, a) => got.push([id, a]));
    expect(attr.attribute(change(), T0)).toBeUndefined();
    hub.ingestRaw([commitEv(T0 - 3_600_000, T0 + 2500, ['src/a.ts'], 'Pulled change')], gitHints);
    expect(got).toHaveLength(1);
    expect(got[0][1]).toMatchObject({ agent: 'git', sessionId: 'Ann', confidence: 'exact', intent: 'Pulled change' });
  });
});
