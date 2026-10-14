import { describe, it, expect } from 'vitest';
import { toolLabel, toolPaths, patchPaths, redactSecretInput, touchesSecret, outputMentionsSecret, SECRET_COMMAND } from '../../src/agents/labels.js';

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

