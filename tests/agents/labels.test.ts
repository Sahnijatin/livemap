import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolLabel, toolMeta, toolPaths, patchPaths, redactSecretInput, touchesSecret, outputMentionsSecret, SECRET_COMMAND, REAL_CACHE_MS } from '../../src/agents/labels.js';

describe('toolLabel', () => {
  it('labels known tools', () => {
    expect(toolLabel('Read', { file_path: '/p/src/a.ts' }, '/p')).toBe('Read src/a.ts');
    expect(toolLabel('Read', { file_path: '/a/b/c/d/e.ts' })).toBe('Read c/d/e.ts');
    expect(toolLabel('Bash', { command: 'npm test -- --run' })).toBe('$ npm test -- --run');
    expect(toolLabel('Grep', { pattern: 'listOrders' })).toBe('Search "listOrders"');
    expect(toolLabel('Glob', { pattern: 'src/**/*.ts' })).toBe('Find files src/**/*.ts');
    expect(toolLabel('WebFetch', { url: 'https://x.dev/a' })).toBe('Fetch https://x.dev/a');
    expect(toolLabel('WebSearch', { query: 'zod enum' })).toBe('Web search "zod enum"');
    expect(toolLabel('Task', { description: 'Explore repo' })).toBe('Subagent: Explore repo');
    expect(toolLabel('apply_patch', { command: '*** Begin Patch\n*** Update File: src/x.ts\n@@\n*** End Patch' })).toBe('Patch src/x.ts');
    expect(toolLabel('Shell', { command: 'ls' })).toBe('$ ls');
    expect(toolLabel('write_file', { file_path: 'a.py' })).toBe('Write a.py');
    expect(toolLabel('Mystery', {})).toBe('Mystery');
  });
  it('handles array commands, odd input and truncation', () => {
    expect(toolLabel('Bash', { command: ['git', 'status'] })).toBe('$ git status');
    expect(toolLabel('Read', null)).toBe('Read');
    const l = toolLabel('Bash', { command: 'x'.repeat(500) });
    expect(l.length).toBeLessThanOrEqual(160);
    expect(l.endsWith('…')).toBe(true);
  });
});

describe('toolPaths', () => {
  it('extracts root-relative paths', () => {
    expect(toolPaths('Edit', { file_path: '/p/src/a.ts' }, '/p')).toEqual(['src/a.ts']);
    expect(toolPaths('MultiEdit', { file_path: '/p/b.ts' }, '/p')).toEqual(['b.ts']);
    expect(toolPaths('Write', { file_path: '/elsewhere/c.ts' }, '/p')).toEqual([]);
    expect(toolPaths('NotebookEdit', { notebook_path: '/p/n.ipynb' }, '/p')).toEqual(['n.ipynb']);
    expect(toolPaths('Read', { file_path: 'rel/x.ts' }, '/p')).toEqual(['rel/x.ts']);
    expect(toolPaths('Read', { file_path: '../out.ts' }, '/p')).toEqual([]);
  });
  it('reads apply_patch paths', () => {
    expect(toolPaths('apply_patch', { command: '*** Begin Patch\n*** Add File: src/n.ts\n+x\n*** Update File: src/o.ts\n*** Delete File: old.ts\n*** End Patch' }, '/p')).toEqual(['old.ts', 'src/n.ts', 'src/o.ts']);
  });
});

describe('patchPaths', () => {
  it('includes move targets', () => {
    expect(patchPaths('*** Update File: a.ts\n*** Move to: b.ts')).toEqual(['a.ts', 'b.ts']);
  });
});

describe('redactSecretInput', () => {
  it('drops contents for secret paths only', () => {
    expect(redactSecretInput('Write', { file_path: '/p/.env', content: 'K=secret' })).toEqual({ file_path: '/p/.env' });
    expect(redactSecretInput('Edit', { file_path: '/p/.ENV.local', old_string: 'a', new_string: 'b' })).toEqual({ file_path: '/p/.ENV.local' });
    expect(redactSecretInput('Write', { file_path: '/p/a.ts', content: 'x' })).toEqual({ file_path: '/p/a.ts', content: 'x' });
  });
});

describe('C1: shell commands and outputs that touch secret files', () => {
  it('shell commands naming a secret path (globs included) are redacted and labeled', () => {
    for (const command of ['cat .env*', 'echo K=v >> .env', 'source .envrc.local', 'cat {.env,.env.local}', 'cat /p/cfg/.env']) {
      expect(redactSecretInput('Bash', { command }), command).toEqual({ command: SECRET_COMMAND });
      expect(toolLabel('Bash', { command }), command).toBe('$ (command touching .env)');
      expect(touchesSecret('Bash', { command }, []), command).toBe(true);
    }
    expect(redactSecretInput('exec_command', { cmd: 'cat .env' })).toEqual({ command: SECRET_COMMAND });
    expect(toolLabel('Bash', { command: SECRET_COMMAND })).toBe('$ (command touching .env)');
    expect(touchesSecret('Bash', { command: SECRET_COMMAND }, [])).toBe(true);
    expect(redactSecretInput('Bash', { command: 'cat .env.example' })).toEqual({ command: 'cat .env.example' });
    expect(touchesSecret('Bash', { command: 'ls -la' }, [])).toBe(false);
  });
  it('touchesSecret covers paths, out-of-root inputs and already redacted inputs', () => {
    expect(touchesSecret('Read', { file_path: 'a.ts' }, ['.env'])).toBe(true);
    expect(touchesSecret('Read', { file_path: '/elsewhere/.env' }, [])).toBe(true);
    expect(touchesSecret('MultiEdit', { file_path: '/p/.env.local' }, ['.env.local'])).toBe(true);
    expect(touchesSecret('apply_patch', { command: '*** Update File: .envrc.local' }, [])).toBe(true);
    expect(touchesSecret('Read', { file_path: '/p/a.ts' }, ['a.ts'])).toBe(false);
  });
  it('Windows: backslash paths and commands are secret', () => {
    expect(touchesSecret('Read', { file_path: 'C:\\p\\.env' }, [])).toBe(true);
    expect(redactSecretInput('Write', { file_path: 'C:\\p\\.env', content: 'K=v' })).toEqual({ file_path: 'C:\\p\\.env' });
    for (const command of ['type ..\\.env', 'Get-Content .\\.env', 'Get-Content C:\\p\\.env*']) {
      expect(redactSecretInput('Shell', { command }), command).toEqual({ command: SECRET_COMMAND });
      expect(toolLabel('Shell', { command }), command).toBe('$ (command touching .env)');
    }
    expect(outputMentionsSecret('config\\.env:3:WK=v')).toBe(true);
    expect(outputMentionsSecret('config\\.env.example:3:WK=')).toBe(false);
  });
  it('outputMentionsSecret finds secret file references, not examples', () => {
    expect(outputMentionsSecret('.env:3:STRIPE_KEY=sk_live_1')).toBe(true);
    expect(outputMentionsSecret('src/a.ts:1:x\napps/web/.env.local:2:K=v')).toBe(true);
    expect(outputMentionsSecret("cat: '.envrc'")).toBe(true);
    expect(outputMentionsSecret('.env.example:1:K=')).toBe(false);
    expect(outputMentionsSecret('loaded environment.ts')).toBe(false);
    expect(outputMentionsSecret('process.env.KEY')).toBe(false);
  });
  it('outputMentionsSecret covers credential rc files (#18)', () => {
    expect(outputMentionsSecret('.npmrc:1://registry.npmjs.org/:_authToken=npm_SECRET')).toBe(true);
    expect(outputMentionsSecret('cat: /home/u/.netrc')).toBe(true);
    expect(outputMentionsSecret("'.pypirc' password = x")).toBe(true);
    expect(outputMentionsSecret('pkg/.npmrc.bak:1:_authToken=x')).toBe(true);
    expect(outputMentionsSecret('.npmrc.example:1:registry=')).toBe(false);
    expect(outputMentionsSecret('.pypirc-sample:1:[pypi]')).toBe(false);
  });
});

describe('M4: relative paths resolve against cwd', () => {
  it('joins cwd before relativizing to root', () => {
    expect(toolPaths('Edit', { file_path: 'src/a.ts' }, '/p', '/p/apps/web')).toEqual(['apps/web/src/a.ts']);
    expect(toolPaths('Edit', { file_path: '../b.ts' }, '/p', '/p/apps')).toEqual(['b.ts']);
    expect(toolPaths('Edit', { file_path: '../../x.ts' }, '/p', '/p/apps')).toEqual([]);
    expect(toolPaths('apply_patch', { command: '*** Update File: a.ts' }, '/p', '/p/pkg')).toEqual(['pkg/a.ts']);
    expect(toolLabel('Edit', { file_path: 'src/a.ts' }, '/p', '/p/apps/web')).toBe('Edit apps/web/src/a.ts');
    expect(toolPaths('Edit', { file_path: 'src/a.ts' }, '/p')).toEqual(['src/a.ts']);
  });
});

describe('review fixes: absolute paths with ..', () => {
  it('normalizes them before mapping to the root, and rejects ones that leave it', () => {
    expect(toolPaths('Edit', { file_path: '/p/src/../lib/a.ts' }, '/p')).toEqual(['lib/a.ts']);
    expect(toolPaths('Edit', { file_path: '/p/../other/x.ts' }, '/p')).toEqual([]);
    expect(toolPaths('Edit', { file_path: '/p/./src//a.ts' }, '/p')).toEqual(['src/a.ts']);
  });
});


describe('symlinked project folder (#32)', () => {
  it('maps paths named through a symlink onto the real root', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-link-')));
    try {
      const real = path.join(tmp, 'real', 'app');
      fs.mkdirSync(path.join(real, 'src'), { recursive: true });
      fs.writeFileSync(path.join(real, 'src', 'a.ts'), '');
      fs.mkdirSync(path.join(tmp, 'link'));
      fs.symlinkSync(real, path.join(tmp, 'link', 'app'), 'dir');
      const viaLink = path.join(tmp, 'link', 'app');
      expect(toolPaths('Edit', { file_path: `${viaLink}/src/a.ts` }, real)).toEqual(['src/a.ts']);
      // A file not created yet still maps through its existing parent.
      expect(toolPaths('Write', { file_path: `${viaLink}/src/new/b.ts` }, real)).toEqual(['src/new/b.ts']);
      expect(toolPaths('Edit', { file_path: 'src/a.ts' }, real, viaLink)).toEqual(['src/a.ts']);
      expect(toolLabel('Read', { file_path: `${viaLink}/src/a.ts` }, real)).toBe('Read src/a.ts');
      expect(toolPaths('Edit', { file_path: `${tmp}/link/other.ts` }, real)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#40: resolves an outside path once, then answers repeats from the cache', () => {
    const outside = path.join(os.tmpdir(), `lm-outside-${process.pid}-${Date.now()}`, 'deep', 'missing', 'x.ts');
    const spy = vi.spyOn(fs, 'realpathSync');
    try {
      expect(toolPaths('Read', { file_path: outside }, '/p')).toEqual([]);
      expect(toolLabel('Read', { file_path: outside }, '/p')).toBe('Read deep/missing/x.ts');
      const first = spy.mock.calls.length;
      // Walks down from the longest prefix and stops at the first that exists (the tmp dir).
      expect(first).toBe(5);
      spy.mockClear();
      expect(toolPaths('Read', { file_path: outside }, '/p')).toEqual([]);
      expect(toolLabel('Read', { file_path: outside }, '/p')).toBe('Read deep/missing/x.ts');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('#40: sees a symlink created after an earlier lookup missed, once the cache entry expires', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-late-')));
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      const real = path.join(tmp, 'real');
      fs.mkdirSync(path.join(real, 'src'), { recursive: true });
      const link = path.join(tmp, 'later');
      expect(toolPaths('Edit', { file_path: `${link}/src/a.ts` }, real)).toEqual([]);
      fs.symlinkSync(real, link, 'dir');
      vi.setSystemTime(Date.now() + REAL_CACHE_MS + 1);
      expect(toolPaths('Edit', { file_path: `${link}/src/a.ts` }, real)).toEqual(['src/a.ts']);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('#49: MCP and SkyForge nexus calls', () => {
  const EXEC = 'nexus_ses_ebf63bf49ffeGGE3hEhWQuinBE_tool_execute';
  const SYS_ID = '871f6b2a1b2c3d4e5f60718293a4b5c6';

  it('labels a tool_execute call by its inner tool, action, table and record', () => {
    expect(toolLabel(EXEC, { tool: 'sn_record_manage', args: { table: 'sys_script', action: 'update', sys_id: SYS_ID } })).toBe('sn_record_manage update sys_script 871f6b2a…');
    expect(toolLabel(EXEC, { tool: 'sn_get_instance_info', args: {} })).toBe('sn_get_instance_info');
    expect(toolLabel('sn_query_table', { table: 'sp_widget', query: 'active=true' })).toBe('sn_query_table sp_widget');
    expect(toolLabel(EXEC, { tool: 'sn_update_set_manage', args: { action: 'create', name: 'CC v2' } })).toBe('sn_update_set_manage create CC v2');
  });

  it('keeps the full name of MCP tools that name no table', () => {
    expect(toolLabel('mcp__github__create_or_update_file', { path: 'a.ts', content: 'x' })).toBe('mcp__github__create_or_update_file');
    expect(toolLabel(EXEC, { query: 'x' })).toBe(EXEC);
  });

  it('reads paths from a gateway call\'s inner args', () => {
    expect(toolPaths(EXEC, { tool: 'sn_pull_artifact', args: { file_path: '/p/src/w.html' } }, '/p')).toEqual(['src/w.html']);
    expect(toolPaths('mcp__github__create_or_update_file', { path: 'src/a.ts' }, '/p', '/p')).toEqual(['src/a.ts']);
  });

  it('redacts secret paths inside a gateway call and keeps the wrapper', () => {
    const input = { tool: 'write_file', args: { file_path: '.env', content: 'KEY=1' } };
    expect(redactSecretInput(EXEC, input)).toEqual({ tool: 'write_file', args: { file_path: '.env' } });
    const safe = { tool: 'sn_query_table', args: { table: 't' } };
    expect(redactSecretInput(EXEC, safe)).toBe(safe);
  });

  it('toolMeta stores inner tool, access and targets', () => {
    expect(toolMeta(EXEC, { tool: 'sn_push_artifact', args: { table: 'sp_widget', sys_id: SYS_ID } })).toEqual({
      inner: 'sn_push_artifact', access: 'write', targets: [{ kind: 'record', instance: '', table: 'sp_widget', sysId: SYS_ID }],
    });
    expect(toolMeta('Read', { file_path: 'a' })).toEqual({});
    expect(toolMeta('mcp__github__list_issues', {})).toEqual({ access: 'read' });
  });
});
