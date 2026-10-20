import { describe, it, expect } from 'vitest';
import { currentTarget } from './live';
import { event, session, change } from './fixtures';

const NOW = 1_000_000;
const sess = (extra = {}) => ({ s1: session({ id: 's1', status: 'working', lastAt: NOW - 1000, ...extra }) });
const start = (name: string, paths: string[], id = 't1', extra = {}) =>
  event({ sessionId: 's1', type: 'tool_start', at: NOW - 2000, tool: { id, name, label: name, paths }, ...extra });
const end = (id = 't1') => event({ sessionId: 's1', type: 'tool_end', at: NOW - 1500, tool: { id, name: 'Edit', label: 'Edit', paths: [] } });
const attributed = (path: string, ageMs: number) =>
  change(path, 'modified', { at: NOW - ageMs, attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'exact' } });

describe('currentTarget', () => {
  it('returns the path of a running Edit tool_start', () => {
    expect(currentTarget([start('Edit', ['src/a.ts'])], [], sess(), NOW)).toEqual({ path: 'src/a.ts', since: NOW - 2000 });
  });
  it('returns null after the tool_end when there is no change', () => {
    expect(currentTarget([start('Edit', ['src/a.ts']), end()], [], sess(), NOW)).toBeNull();
  });
  it('falls back to a change within 10 s from a working session', () => {
    expect(currentTarget([], [attributed('src/b.ts', 3000)], sess(), NOW)?.path).toBe('src/b.ts');
    expect(currentTarget([], [attributed('src/b.ts', 15000)], sess(), NOW)).toBeNull();
  });
  it('returns null for an idle session', () => {
    const idle = sess({ status: 'idle' });
    expect(currentTarget([start('Edit', ['src/a.ts'])], [attributed('src/b.ts', 1000)], idle, NOW)).toBeNull();
  });
  it('ignores read tools and shell without paths', () => {
    expect(currentTarget([start('Read', ['src/a.ts'])], [], sess(), NOW)).toBeNull();
    expect(currentTarget([start('Bash', [])], [], sess(), NOW)).toBeNull();
  });
  it('counts shell with paths, and ignores a session silent for over 60 s', () => {
    expect(currentTarget([start('Bash', ['out.txt'])], [], sess(), NOW)?.path).toBe('out.txt');
    expect(currentTarget([start('Edit', ['src/a.ts'])], [], sess({ lastAt: NOW - 61_000 }), NOW)).toBeNull();
  });
  it('counts MCP writes with paths and ignores MCP reads (#49)', () => {
    expect(currentTarget([start('mcp__github__create_or_update_file', ['src/a.ts'])], [], sess(), NOW)?.path).toBe('src/a.ts');
    expect(currentTarget([start('mcp__github__get_file_contents', ['src/a.ts'])], [], sess(), NOW)).toBeNull();
    const pull = event({ sessionId: 's1', type: 'tool_start', at: NOW - 2000, tool: { id: 't1', name: 'tool_execute', label: 'x', paths: ['src/w.html'], inner: 'sn_pull_artifact', access: 'read' } });
    expect(currentTarget([pull], [], sess(), NOW)).toBeNull();
  });
  it('trusts the server\'s access, and reads write names when it is missing (built-in tools, older events)', () => {
    const call = (name: string, extra: Record<string, unknown> = {}) => event({ sessionId: 's1', type: 'tool_start', at: NOW - 2000, tool: { id: 't1', name, label: name, paths: ['src/a.ts'], ...extra } });
    expect(currentTarget([call('mcp__nexus__sn_push_artifact', { access: 'write' })], [], sess(), NOW)?.path).toBe('src/a.ts');
    expect(currentTarget([call('mcp__x__create_thing', { access: 'read' })], [], sess(), NOW)).toBeNull();
    for (const name of ['MultiEdit', 'apply_patch', 'NotebookEdit', 'mcp__fs__write_file', 'mcp__x__delete_record', 'nexus_ses_ab12_sn_execute_background_script']) {
      expect(currentTarget([call(name)], [], sess(), NOW)?.path, name).toBe('src/a.ts');
    }
    for (const name of ['TodoWrite', 'mcp__nexus__sn_query_table', 'Grep', 'mcp__x__settings_get']) {
      expect(currentTarget([call(name)], [], sess(), NOW), name).toBeNull();
    }
  });
  it('pairs by session and tool id', () => {
    const evs = [start('Edit', ['src/a.ts'], 't1'), start('Edit', ['src/c.ts'], 't2'), end('t2')];
    expect(currentTarget(evs, [], sess(), NOW)?.path).toBe('src/a.ts');
  });
  it('ignores a deleted change and a change from a non-working session', () => {
    const del = change('src/b.ts', 'deleted', { at: NOW - 1000, attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'exact' } });
    expect(currentTarget([], [del], sess(), NOW)).toBeNull();
    expect(currentTarget([], [attributed('src/b.ts', 1000)], {}, NOW)).toBeNull();
    expect(currentTarget([start('Edit', ['src/a.ts'])], [], {}, NOW)).toBeNull();
  });
  it('a later prompt closes older tools of that session', () => {
    const evs = [start('Edit', ['src/a.ts']), event({ sessionId: 's1', type: 'prompt', at: NOW - 1000, text: 'next' })];
    expect(currentTarget(evs, [], sess(), NOW)).toBeNull();
  });
  it('counts a subagent write tool as the session target', () => {
    expect(currentTarget([start('Write', ['src/sub.ts'], 'sa1', { subagent: true })], [], sess(), NOW)?.path).toBe('src/sub.ts');
  });
});
