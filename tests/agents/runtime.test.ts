import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntime, removeRuntime, runtimeDir, runtimeFor, writeRuntime } from '../../src/agents/runtime.js';

let home: string;
let root: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.LIVEMAP_HOME;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-')));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-root-')));
  process.env.LIVEMAP_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LIVEMAP_HOME;
  else process.env.LIVEMAP_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime file', () => {
  it('lives under <LIVEMAP_HOME>/run', () => {
    expect(runtimeDir()).toBe(path.join(home, 'run'));
  });

  it('is named by the sha1 of the realpath of root and written with mode 0600 in a 0700 dir', () => {
    const file = writeRuntime(root, 4321, 'tok');
    const name = crypto.createHash('sha1').update(root).digest('hex');
    expect(file).toBe(path.join(home, 'run', `${name}.json`));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ root, port: 4321, token: 'tok', pid: process.pid });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(runtimeDir()).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(runtimeDir())).toEqual([`${name}.json`]);
  });

  it('is found from a subdirectory of root', () => {
    writeRuntime(root, 4321, 'tok');
    const sub = path.join(root, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findRuntime(sub)).toEqual({ root, port: 4321, token: 'tok', pid: process.pid });
    expect(findRuntime(root)).toEqual({ root, port: 4321, token: 'tok', pid: process.pid });
  });

  // Windows: creating a symlink needs admin rights or Developer Mode.
  it.skipIf(process.platform === 'win32')('is found through a symlinked path to root', () => {
    writeRuntime(root, 4321, 'tok');
    const link = path.join(home, 'link');
    fs.symlinkSync(root, link);
    expect(findRuntime(path.join(link))?.root).toBe(root);
  });

  it('returns null outside any root and when no runtime dir exists', () => {
    expect(findRuntime(root)).toBeNull();
    writeRuntime(root, 4321, 'tok');
    expect(findRuntime(home)).toBeNull();
    expect(findRuntime(path.join(root, 'missing', 'dir'))?.root).toBe(root);
  });

  it('ignores an entry whose pid is dead', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise(r => child.on('exit', r));
    const file = writeRuntime(root, 4321, 'tok');
    fs.writeFileSync(file, JSON.stringify({ root, port: 4321, token: 'tok', pid }));
    expect(findRuntime(root)).toBeNull();
  });

  it('ignores a malformed entry', () => {
    const file = writeRuntime(root, 4321, 'tok');
    fs.writeFileSync(file, '{not json');
    expect(findRuntime(root)).toBeNull();
  });

  it('removeRuntime deletes the file and tolerates a missing one', () => {
    const file = writeRuntime(root, 4321, 'tok');
    removeRuntime(root);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeRuntime(root)).not.toThrow();
  });

  it('D2: removeRuntime leaves a file written by another process alone', () => {
    const file = writeRuntime(root, 4321, 'tok');
    const other = { ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: process.pid + 1, token: 'theirs' };
    fs.writeFileSync(file, JSON.stringify(other));
    removeRuntime(root);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe('theirs');
    fs.writeFileSync(file, 'not json');
    removeRuntime(root);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('#21: writeRuntime refuses to replace the entry of another live LiveMap', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const file = writeRuntime(root, 4321, 'tok');
      fs.writeFileSync(file, JSON.stringify({ root, port: 9999, token: 'theirs', pid: other.pid }));
      expect(() => writeRuntime(root, 4321, 'tok')).toThrow(`another LiveMap (pid ${other.pid})`);
      expect(runtimeFor(root)).toEqual({ root, port: 9999, token: 'theirs', pid: other.pid });
    } finally {
      other.kill('SIGKILL');
      await new Promise(r => other.on('exit', r));
    }
    // Its owner is gone now: the entry is stale and may be replaced.
    writeRuntime(root, 4321, 'tok');
    expect(runtimeFor(root)?.token).toBe('tok');
  });

  it('#40: the project lock holder replaces an entry whose pid an unrelated live process reuses', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const file = writeRuntime(root, 4321, 'tok');
      fs.writeFileSync(file, JSON.stringify({ root, port: 9999, token: 'stale', pid: other.pid }));
      expect(writeRuntime(root, 4321, 'tok', { takeover: true })).toBe(file);
      expect(runtimeFor(root)).toEqual({ root, port: 4321, token: 'tok', pid: process.pid });
    } finally {
      other.kill('SIGKILL');
      await new Promise(r => other.on('exit', r));
    }
  });
});
