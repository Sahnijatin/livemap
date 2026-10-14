import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initAgents, removeAgents, detectAgents, hookCommand } from '../src/init.js';

let root: string;
/** LiveMap home (init state lives here). */
let home: string;
let userHome: string;
let savedHome: string | undefined;
const hookPath = '/opt/lm/bin/livemap-hook.mjs';

const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const write = (rel: string, v: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(v));
};
const isLm = (cmd: unknown) => typeof cmd === 'string' && cmd.includes('livemap-hook.mjs');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-init-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-inithome-')));
  userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-inituser-')));
  savedHome = process.env.HOME;
  process.env.HOME = userHome; // detection reads os.homedir()
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = savedHome;
  for (const d of [root, home, userHome]) fs.rmSync(d, { recursive: true, force: true });
});

const USER_CLAUDE = {
  permissions: { allow: ['Bash(ls)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] },
};
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const CODEX_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const CURSOR_EVENTS = ['beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'preToolUse', 'postToolUse', 'beforeShellExecution', 'afterShellExecution', 'afterFileEdit', 'stop'];

describe('hookCommand', () => {
  it('quotes the hook path and names agent and event', () => {
    expect(hookCommand(hookPath, 'claude-code', 'Stop')).toBe(`node "${hookPath}" claude-code Stop`);
  });
  it('rejects paths holding a double quote', () => {
    expect(() => hookCommand('/a"b/livemap-hook.mjs', 'codex', 'Stop')).toThrow();
  });
});

describe('initAgents: claude', () => {
  it('creates settings.local.json with one LiveMap group per event', () => {
    const res = initAgents(root, { agents: ['claude'], hookPath, home });
    expect(res).toEqual([{ agent: 'claude', file: '.claude/settings.local.json', action: 'created' }]);
    const raw = fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "hooks"');
    const cfg = JSON.parse(raw);
    expect(Object.keys(cfg.hooks)).toEqual(CLAUDE_EVENTS);
    expect(cfg.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: `node "${hookPath}" claude-code PreToolUse`, timeout: 5 }] }]);
    expect(cfg.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: `node "${hookPath}" claude-code SessionStart`, timeout: 5 }] }]);
  });

  it('preserves user hooks and permissions, is idempotent, and remove restores the original', () => {
    write('.claude/settings.local.json', USER_CLAUDE);
    expect(initAgents(root, { agents: ['claude'], hookPath, home })[0].action).toBe('updated');
    expect(initAgents(root, { agents: ['claude'], hookPath, home })[0].action).toBe('unchanged');
    const cfg = read('.claude/settings.local.json');
    expect(cfg.permissions).toEqual(USER_CLAUDE.permissions);
    expect(cfg.hooks.PreToolUse[0]).toEqual(USER_CLAUDE.hooks.PreToolUse[0]);
    for (const ev of CLAUDE_EVENTS) {
      const lm = cfg.hooks[ev].filter((g: { hooks: { command: string }[] }) => g.hooks.some(h => isLm(h.command)));
      expect(lm).toHaveLength(1);
    }
    expect(removeAgents(root, { home })).toEqual([{ agent: 'claude', file: '.claude/settings.local.json', action: 'removed' }]);
    expect(read('.claude/settings.local.json')).toEqual(USER_CLAUDE);
    expect(fs.readdirSync(path.join(home, 'init'))).toEqual([]); // the init record is gone too
    expect(removeAgents(root, { home })[0].action).toBe('unchanged');
  });

  it('updates LiveMap entries in place when the hook path moves', () => {
    write('.claude/settings.local.json', USER_CLAUDE);
    initAgents(root, { agents: ['claude'], hookPath, home });
    const before = read('.claude/settings.local.json');
    const moved = '/new/place/livemap-hook.mjs';
    expect(initAgents(root, { agents: ['claude'], hookPath: moved, home })[0].action).toBe('updated');
    const after = read('.claude/settings.local.json');
    expect(JSON.stringify(after)).toBe(JSON.stringify(before).split(hookPath).join(moved));
  });

  it('skips a config file that is not valid JSON and leaves it untouched', () => {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude/settings.local.json'), '{ nope');
    const res = initAgents(root, { agents: ['claude', 'codex'], hookPath, home });
    expect(res[0]).toMatchObject({ agent: 'claude', action: 'skipped' });
    expect(res[0].reason).toBeTruthy();
    expect(res[1]).toMatchObject({ agent: 'codex', action: 'created' });
    expect(fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8')).toBe('{ nope');
    expect(removeAgents(root, { home }).find(r => r.agent === 'claude')!.action).toBe('skipped');
  });
});

describe('initAgents: codex', () => {
  it('writes groups without a matcher, and remove deletes a file LiveMap created', () => {
    initAgents(root, { agents: ['codex'], hookPath, home });
    const cfg = read('.codex/hooks.json');
    expect(Object.keys(cfg.hooks)).toEqual(CODEX_EVENTS);
    expect(cfg.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: `node "${hookPath}" codex Stop`, timeout: 5 }] }]);
    expect(removeAgents(root, { home })).toEqual([{ agent: 'codex', file: '.codex/hooks.json', action: 'deleted' }]);
    expect(fs.existsSync(path.join(root, '.codex/hooks.json'))).toBe(false);
  });
});

describe('initAgents: cursor', () => {
  const USER_CURSOR = { version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } };

  it('preserves a user hook, is idempotent, and remove restores the original', () => {
    write('.cursor/hooks.json', USER_CURSOR);
    expect(initAgents(root, { agents: ['cursor'], hookPath, home })[0].action).toBe('updated');
    expect(initAgents(root, { agents: ['cursor'], hookPath, home })[0].action).toBe('unchanged');
    const cfg = read('.cursor/hooks.json');
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.afterFileEdit).toEqual([{ command: './format.sh' }, { command: `node "${hookPath}" cursor afterFileEdit` }]);
    for (const ev of CURSOR_EVENTS) expect(cfg.hooks[ev].filter((h: { command: string }) => isLm(h.command))).toHaveLength(1);
    expect(removeAgents(root, { home })[0].action).toBe('removed');
    expect(read('.cursor/hooks.json')).toEqual(USER_CURSOR);
  });

  it('deletes a cursor file that LiveMap created alone', () => {
    expect(initAgents(root, { agents: ['cursor'], hookPath, home })[0].action).toBe('created');
    expect(Object.keys(read('.cursor/hooks.json').hooks)).toEqual(CURSOR_EVENTS);
    expect(removeAgents(root, { home })).toEqual([{ agent: 'cursor', file: '.cursor/hooks.json', action: 'deleted' }]);
    expect(fs.existsSync(path.join(root, '.cursor/hooks.json'))).toBe(false);
  });
});

describe('detection', () => {
  it('configures only codex when HOME holds only .codex', () => {
    fs.mkdirSync(path.join(userHome, '.codex'));
    expect(detectAgents(root)).toEqual(['codex']);
    const res = initAgents(root, { hookPath, home });
    expect(res.map(r => r.agent)).toEqual(['codex']);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.cursor'))).toBe(false);
  });

  it('detects agents from project directories too', () => {
    fs.mkdirSync(path.join(root, '.cursor'));
    fs.mkdirSync(path.join(root, '.claude'));
    expect(detectAgents(root)).toEqual(['claude', 'cursor']);
  });
});

describe('.git/info/exclude', () => {
  it('gains both hook files exactly once', () => {
    fs.mkdirSync(path.join(root, '.git/info'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git/info/exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log');
    initAgents(root, { agents: ['claude'], hookPath, home });
    initAgents(root, { agents: ['codex', 'cursor'], hookPath, home });
    const lines = fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8').split('\n');
    expect(lines.filter(l => l === '.codex/hooks.json')).toHaveLength(1);
    expect(lines.filter(l => l === '.cursor/hooks.json')).toHaveLength(1);
    expect(lines.filter(l => l === '.claude/settings.local.json')).toHaveLength(1);
    expect(lines).toContain('*.log');
  });

  it('is left alone when .git is not a directory', () => {
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
    initAgents(root, { agents: ['claude'], hookPath, home });
    expect(fs.readFileSync(path.join(root, '.git'), 'utf8')).toBe('gitdir: /elsewhere\n');
  });
});

describe('exact round trip of user files', () => {
  const cases: [string, string, unknown][] = [
    ['claude', '.claude/settings.local.json', { permissions: { allow: ['Bash(ls)'] }, hooks: {} }],
    ['claude', '.claude/settings.local.json', { hooks: { Stop: [] } }],
    ['codex', '.codex/hooks.json', { hooks: { Stop: [{ hooks: [] }] } }],
    ['cursor', '.cursor/hooks.json', { hooks: { stop: [{ command: './done.sh' }] } }],
    ['cursor', '.cursor/hooks.json', { version: 1, hooks: {} }],
  ];
  for (const [agent, file, original] of cases) {
    it(`${agent}: ${JSON.stringify(original)}`, () => {
      write(file, original);
      expect(initAgents(root, { agents: [agent as 'claude'], hookPath, home })[0].action).toBe('updated');
      expect(removeAgents(root, { home })[0].action).toBe('removed');
      expect(read(file)).toEqual(original);
    });
  }

  it('re-init keeps track of what LiveMap created first', () => {
    write('.cursor/hooks.json', { hooks: {} });
    initAgents(root, { agents: ['cursor'], hookPath, home });
    initAgents(root, { agents: ['cursor'], hookPath: '/moved/livemap-hook.mjs', home });
    removeAgents(root, { home });
    expect(read('.cursor/hooks.json')).toEqual({ hooks: {} });
  });
});

describe('LiveMap entry detection', () => {
  it('never touches user hooks that merely mention a similar file name', () => {
    const user = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node ~/x/not-livemap-hook.mjs' }] },
          { hooks: [{ type: 'command', command: 'node "/x/not-livemap-hook.mjs" codex Stop' }] },
          { hooks: [{ type: 'command', command: 'node "/x/livemap-hook.mjs" codex Stop --extra' }] },
        ],
      },
    };
    write('.codex/hooks.json', user);
    initAgents(root, { agents: ['codex'], hookPath, home });
    const cfg = read('.codex/hooks.json');
    expect(cfg.hooks.Stop.slice(0, 3)).toEqual(user.hooks.Stop);
    expect(cfg.hooks.Stop).toHaveLength(4);
    expect(removeAgents(root, { home })[0].action).toBe('removed');
    expect(read('.codex/hooks.json')).toEqual(user);
    expect(removeAgents(root, { home })[0].action).toBe('unchanged');
  });
});

describe('malformed configs are skipped and left byte-identical', () => {
  const bad: [string, string, string][] = [
    ['claude', '.claude/settings.local.json', '{"hooks":[]}'],
    ['claude', '.claude/settings.local.json', '{"hooks":{"Stop":{"hooks":[]}}}'],
    ['claude', '.claude/settings.local.json', '{"hooks":{"Stop":[{"hooks":"node x"}]}}'],
    ['codex', '.codex/hooks.json', '{"hooks":{"Stop":[42]}}'],
    ['cursor', '.cursor/hooks.json', '{"version":1,"hooks":{"stop":["./x.sh"]}}'],
    ['cursor', '.cursor/hooks.json', '[1,2]'],
  ];
  for (const [agent, file, text] of bad) {
    it(`${agent}: ${text}`, () => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
      const [r] = initAgents(root, { agents: [agent as 'claude'], hookPath, home });
      expect(r.action).toBe('skipped');
      expect(r.reason).toBeTruthy();
      expect(removeAgents(root, { agents: [agent as 'claude'], home })[0].action).toBe('skipped');
      expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(text);
    });
  }
});

describe('safe writes', () => {
  it('writes through a symlink, keeps the file mode, and leaves no temp files', () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-initlink-')));
    try {
      const target = path.join(elsewhere, 'settings.json');
      fs.writeFileSync(target, JSON.stringify(USER_CLAUDE), { mode: 0o600 });
      fs.chmodSync(target, 0o600);
      fs.mkdirSync(path.join(root, '.claude'));
      fs.symlinkSync(target, path.join(root, '.claude/settings.local.json'));
      initAgents(root, { agents: ['claude'], hookPath, home });
      expect(fs.lstatSync(path.join(root, '.claude/settings.local.json')).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.Stop).toHaveLength(1);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(elsewhere)).toEqual(['settings.json']);
      expect(fs.readdirSync(path.join(root, '.claude'))).toEqual(['settings.local.json']);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('a failed write skips that agent, keeps the original, and carries on', () => {
    write('.claude/settings.local.json', USER_CLAUDE);
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (String(b).endsWith('settings.local.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return real(a, b);
    });
    const res = initAgents(root, { agents: ['claude', 'codex'], hookPath, home });
    expect(res[0]).toMatchObject({ agent: 'claude', action: 'skipped' });
    expect(res[0].reason).toContain('EACCES');
    expect(res[1]).toMatchObject({ agent: 'codex', action: 'created' });
    expect(read('.claude/settings.local.json')).toEqual(USER_CLAUDE);
    expect(fs.readdirSync(path.join(root, '.claude'))).toEqual(['settings.local.json']);
  });

  it('a failed delete on remove is reported as skipped', () => {
    initAgents(root, { agents: ['codex', 'cursor'], hookPath, home });
    const real = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(p => {
      if (String(p).endsWith('.codex/hooks.json')) throw Object.assign(new Error('EACCES: nope'), { code: 'EACCES' });
      return real(p);
    });
    const res = removeAgents(root, { home });
    expect(res[0]).toMatchObject({ agent: 'codex', action: 'skipped' });
    expect(res[1]).toMatchObject({ agent: 'cursor', action: 'deleted' });
  });

  it('a .git/info/exclude failure is a warning, not an error', () => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git/info'), 'not a dir');
    const warnings: string[] = [];
    const res = initAgents(root, { agents: ['claude'], hookPath, home, warn: m => warnings.push(m) });
    expect(res[0].action).toBe('created');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.git/info/exclude');
  });
});

describe('init records', () => {
  it('a stale record never deletes a file the user replaced after init', () => {
    initAgents(root, { agents: ['claude'], hookPath, home });
    fs.writeFileSync(path.join(root, '.claude/settings.local.json'), '{"hooks":{"Stop":[]}}'); // e.g. git checkout
    expect(initAgents(root, { agents: ['claude'], hookPath, home })[0].action).toBe('updated');
    expect(removeAgents(root, { home })[0].action).toBe('removed');
    expect(read('.claude/settings.local.json')).toEqual({ hooks: { Stop: [] } });
  });

  it('remove drops the record when the file holds no LiveMap entries', () => {
    initAgents(root, { agents: ['claude'], hookPath, home });
    fs.writeFileSync(path.join(root, '.claude/settings.local.json'), '{"model":"x"}');
    expect(removeAgents(root, { home })[0].action).toBe('unchanged');
    expect(fs.readdirSync(path.join(home, 'init'))).toEqual([]);
  });

  it('writes no record when LiveMap entries exist without one, so remove falls back to pruning', () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-inithome2-')));
    try {
      initAgents(root, { agents: ['cursor'], hookPath, home: other });
      expect(initAgents(root, { agents: ['cursor'], hookPath: '/moved/livemap-hook.mjs', home })[0].action).toBe('updated');
      expect(fs.existsSync(path.join(home, 'init')) ? fs.readdirSync(path.join(home, 'init')) : []).toEqual([]);
      expect(removeAgents(root, { home })).toEqual([{ agent: 'cursor', file: '.cursor/hooks.json', action: 'deleted' }]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
