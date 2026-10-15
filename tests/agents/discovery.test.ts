import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDirName, findClaudeSessions } from '../../src/agents/discovery.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-disc-')); dirs.push(d); return d; };

describe('claudeProjectDirName', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(claudeProjectDirName('/Users/a/my_app.v2')).toBe('-Users-a-my-app-v2');
    expect(claudeProjectDirName('/Users/a/my_app')).toBe('-Users-a-my-app');
  });
  it('names a Windows project the way Claude Code does: drive colon and backslashes become dashes', () => {
    expect(claudeProjectDirName('C:\\Users\\jatin\\my_app.v2')).toBe('C--Users-jatin-my-app-v2');
  });
});

describe('findClaudeSessions', () => {
  it('returns only fresh jsonl files, newest first', () => {
    const claude = tmp();
    // On Windows a POSIX path resolves onto the current drive (D:\\work\\...), and so does discovery.
    const root = path.resolve('/work/my_app.v2');
    const pd = path.join(claude, 'projects', claudeProjectDirName(root));
    fs.mkdirSync(pd, { recursive: true });
    const now = Date.now();
    const mk = (n: string, ageMs: number) => { const f = path.join(pd, n); fs.writeFileSync(f, '{}\n'); fs.utimesSync(f, (now - ageMs) / 1000, (now - ageMs) / 1000); return f; };
    const fresh = mk('a.jsonl', 5000);
    const fresher = mk('b.jsonl', 1000);
    mk('old.jsonl', 3_600_000);
    mk('note.txt', 100);
    expect(findClaudeSessions(root, claude, 600_000, now)).toEqual([fresher, fresh]);
  });

  it('returns [] when the project dir is missing', () => {
    expect(findClaudeSessions('/nope/x', tmp())).toEqual([]);
  });

  it('defaults claudeDir from CLAUDE_CONFIG_DIR at call time', () => {
    const claude = tmp();
    const root = path.resolve('/work/envproj');
    const pd = path.join(claude, 'projects', claudeProjectDirName(root));
    fs.mkdirSync(pd, { recursive: true });
    const f = path.join(pd, 's.jsonl');
    fs.writeFileSync(f, '{}\n');
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claude;
    try { expect(findClaudeSessions(root)).toEqual([f]); }
    finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  });

  it('also finds sessions under the realpath of a symlinked root', () => {
    const claude = tmp();
    const base = fs.realpathSync.native(tmp());
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const pd = path.join(claude, 'projects', claudeProjectDirName(real));
    fs.mkdirSync(pd, { recursive: true });
    const f = path.join(pd, 's.jsonl');
    fs.writeFileSync(f, '{}\n');
    expect(findClaudeSessions(link, claude)).toEqual([f]);
  });
});
