import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Guardrails, GUARDRAILS_FILE, matchRule, parseGuardrails } from '../../src/agents/guardrails.js';
import { AgentHub } from '../../src/agents/hub.js';

const rules = (o: unknown) => parseGuardrails(JSON.stringify(o));

describe('parseGuardrails', () => {
  it('reads rules with their defaults', () => {
    const r = rules({ rules: [{ paths: ['db/migrations/**'], message: ' Ask first. ' }, { commands: ['git push'], action: 'pause', on: 'any' }] });
    expect(r.errors).toEqual([]);
    expect(r.rules).toEqual([
      { paths: ['db/migrations/**'], commands: [], action: 'block', on: 'write', message: 'Ask first.' },
      { paths: [], commands: ['git push'], action: 'pause', on: 'any' },
    ]);
  });
  it('skips an invalid rule, says which, and keeps the valid ones', () => {
    const r = rules({ rules: [{ action: 'block' }, { paths: ['!keep'] }, { paths: ['a'], action: 'explode' }, { paths: 'a' }, { commands: ['ok'] }] });
    expect(r.rules).toEqual([{ paths: [], commands: ['ok'], action: 'block', on: 'write' }]);
    expect(r.errors).toEqual([
      'rule 1: needs "paths" or "commands"',
      'rule 2: "!" patterns are not supported: !keep',
      'rule 3: "action" must be "block" or "pause"',
      'rule 4: "paths" must be a list of text',
    ]);
  });
  it('reports a file that is not JSON or has no rules list', () => {
    expect(parseGuardrails('{nope').errors).toEqual(['not valid JSON']);
    expect(rules({ rules: {} }).errors).toEqual(['expected {"rules": [...]}']);
    expect(rules([]).errors).toEqual(['expected {"rules": [...]}']);
  });
  it('caps the number of rules', () => {
    const r = rules({ rules: Array.from({ length: 101 }, () => ({ paths: ['a'] })) });
    expect(r.rules).toHaveLength(100);
    expect(r.errors).toEqual(['only the first 100 rules are used']);
  });
});

describe('matchRule', () => {
  const [mig, env, push] = rules({ rules: [{ paths: ['db/migrations/', '*.lock'] }, { paths: ['.env*'], on: 'any' }, { commands: ['git push'] }] }).rules;
  it('matches write paths by gitignore-style patterns and names the path and pattern', () => {
    expect(matchRule(mig, { tool: 'Edit', paths: ['src/a.ts', 'db/migrations/001.sql'], access: 'write' })).toEqual({ target: 'db/migrations/001.sql', pattern: 'db/migrations/' });
    expect(matchRule(mig, { tool: 'Write', paths: ['apps/web/yarn.lock'], access: 'write' })).toEqual({ target: 'apps/web/yarn.lock', pattern: '*.lock' });
    expect(matchRule(mig, { tool: 'Edit', paths: ['src/a.ts'], access: 'write' })).toBeNull();
  });
  it('leaves reads alone unless the rule says on: any', () => {
    expect(matchRule(mig, { tool: 'Read', paths: ['db/migrations/001.sql'], access: 'read' })).toBeNull();
    expect(matchRule(env, { tool: 'Read', paths: ['.env.local'], access: 'read' })).toEqual({ target: '.env.local', pattern: '.env*' });
  });
  it('matches command text and reports the pattern, never the command', () => {
    expect(matchRule(push, { tool: 'Bash', paths: [], command: 'cd x && git push origin main --token=abc', access: 'write' })).toEqual({ target: 'command contains "git push"', pattern: 'git push' });
    expect(matchRule(push, { tool: 'Bash', paths: [], command: 'git status', access: 'write' })).toBeNull();
    expect(matchRule(push, { tool: 'Edit', paths: ['git push'], access: 'write' })).toBeNull();
  });
});

describe('Guardrails store and the hub', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-guard-'))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const write = (o: unknown) => {
    const f = path.join(root, GUARDRAILS_FILE);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
  };
  const hub = () => new AgentHub(root);
  const claude = (h: AgentHub, tool: string, input: unknown, id = 't1') =>
    h.ingestHook('claude-code', 'PreToolUse', { session_id: 's1', cwd: root, tool_name: tool, tool_use_id: id, tool_input: input }, 1000, { settle: true });

  it('has no state without a file, and picks the file up when it appears', () => {
    const g = new Guardrails(root);
    expect(g.state()).toBeUndefined();
    write({ rules: [{ paths: ['a'] }] });
    expect(g.refresh()).toBe(true);
    expect(g.state()).toMatchObject({ file: GUARDRAILS_FILE, rules: [{ paths: ['a'] }], errors: [], hits: [] });
    expect(g.refresh()).toBe(false);
    fs.rmSync(path.join(root, GUARDRAILS_FILE));
    expect(g.refresh()).toBe(true);
    expect(g.state()).toBeUndefined();
  });

  it('blocks a Claude Code write to a guarded path with the reason, and records the hit', () => {
    write({ rules: [{ paths: ['db/migrations/**'], message: 'Ask first.' }] });
    const h = hub();
    const r = claude(h, 'Edit', { file_path: path.join(root, 'db/migrations/001.sql'), old_string: 'a', new_string: 'b' });
    expect(r.block).toBe('Blocked by a LiveMap guardrail: db/migrations/001.sql matches the rule "db/migrations/**". Ask first.');
    r.settle?.(true);
    expect(h.control.state().paused).toBe(false);
    expect(h.control.state().guard?.hits).toEqual([{ at: 1000, rule: 0, action: 'block', target: 'db/migrations/001.sql', agent: 'claude-code', sessionId: 's1', tool: 'Edit' }]);
    expect(claude(h, 'Edit', { file_path: path.join(root, 'src/a.ts') }, 't2').block).toBeNull();
    expect(claude(h, 'Read', { file_path: path.join(root, 'db/migrations/001.sql') }, 't3').block).toBeNull();
    h.stop();
  });

  it('a pause rule blocks the command and pauses every agent', () => {
    write({ rules: [{ commands: ['git push'], action: 'pause' }] });
    const h = hub();
    const r = h.ingestHook('cursor', 'beforeShellExecution', { conversation_id: 'c1', workspace_roots: [root], command: 'git push -f' }, 5);
    expect(r.block).toBe('Blocked by a LiveMap guardrail: command contains "git push". The session is now paused in LiveMap. Stop and wait for the user\'s instructions.');
    expect(h.control.state().paused).toBe(true);
    expect(h.ingestHook('codex', 'PreToolUse', { session_id: 'x', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } }).block).toMatch(/paused/);
    h.stop();
  });

  it('withdraws the hit when the block never reached the hook, and never blocks a hook that gave up', () => {
    write({ rules: [{ paths: ['secret/'] }] });
    const h = hub();
    const r = claude(h, 'Write', { file_path: 'secret/k.txt', content: 'x' });
    expect(r.block).toMatch(/guardrail/);
    r.settle?.(false);
    expect(h.control.state().guard?.hits).toEqual([]);
    expect(h.ingestHook('claude-code', 'PreToolUse', { session_id: 's1', cwd: root, tool_name: 'Write', tool_input: { file_path: 'secret/k.txt' } }, 2000, { canBlock: false }).block).toBeNull();
    h.stop();
  });

  it('reloads edited rules on the next hook and surfaces file errors', () => {
    write({ rules: [{ paths: ['a.txt'] }] });
    const h = hub();
    expect(claude(h, 'Write', { file_path: 'b.txt' }).block).toBeNull();
    write({ rules: [{ paths: ['b.txt', 'and-a-longer-file'] }, { action: 'block' }] });
    expect(claude(h, 'Write', { file_path: 'b.txt' }, 't2').block).toMatch(/b\.txt/);
    expect(h.control.state().guard?.errors).toEqual(['rule 2: needs "paths" or "commands"']);
    h.stop();
  });
});

describe('hub: a message is delivered at the stop hook', () => {
  it('answers Stop with the follow-up for each agent, and puts it back when it was not delivered', () => {
    const h = new AgentHub('/proj');
    h.control.addFlag(null, 'Run the tests', 1, 'message');
    expect(h.ingestHook('claude-code', 'PreToolUse', { session_id: 's', tool_name: 'Read', tool_use_id: 'a', tool_input: { file_path: 'x' } }, 2).followup).toBeUndefined();
    const r = h.ingestHook('claude-code', 'Stop', { session_id: 's' }, 3, { settle: true });
    expect(r.block).toBeNull();
    expect(r.followup).toBe('The user sent this from LiveMap:\nRun the tests');
    r.settle?.(false);
    expect(h.ingestHook('codex', 'Stop', { session_id: 'x' }, 4, { canBlock: false }).followup).toBeUndefined();
    expect(h.ingestHook('cursor', 'stop', { conversation_id: 'c' }, 5).followup).toContain('Run the tests');
    expect(h.ingestHook('codex', 'Stop', { session_id: 'x' }, 6).followup).toBeUndefined();
    h.stop();
  });
});
