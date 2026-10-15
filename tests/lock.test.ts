import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, lockFile, releaseLock } from '../src/lock.js';

let home: string;
let root: string;
let saved: string | undefined;

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => child.on('exit', r));
  return child.pid as number;
}

beforeEach(() => {
  saved = process.env.LIVEMAP_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lockhome-')));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lockroot-')));
  process.env.LIVEMAP_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LIVEMAP_HOME;
  else process.env.LIVEMAP_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('project lock (#21)', () => {
  it('lives under <LIVEMAP_HOME>/locks, named by the sha1 of the realpath of root', () => {
    const name = crypto.createHash('sha1').update(root).digest('hex');
    expect(lockFile(root)).toBe(path.join(home, 'locks', `${name}.lock`));
  });

  it('is taken with this pid, re-entrant for the same process, and released', () => {
    expect(acquireLock(root)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    expect(acquireLock(root)).toEqual({ ok: true });
    expect(fs.readdirSync(path.dirname(lockFile(root)))).toEqual([path.basename(lockFile(root))]);
    releaseLock(root);
    expect(fs.existsSync(lockFile(root))).toBe(false);
    expect(() => releaseLock(root)).not.toThrow();
  });

  it('is refused while another live process holds it, and release leaves that lock alone', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      fs.mkdirSync(path.dirname(lockFile(root)), { recursive: true });
      fs.writeFileSync(lockFile(root), `${other.pid}\n`);
      expect(acquireLock(root)).toEqual({ ok: false, pid: other.pid });
      releaseLock(root);
      expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(other.pid));
    } finally {
      other.kill('SIGKILL');
      await new Promise(r => other.on('exit', r));
    }
  });

  it('replaces a stale lock whose pid is dead or unreadable', async () => {
    fs.mkdirSync(path.dirname(lockFile(root)), { recursive: true });
    fs.writeFileSync(lockFile(root), `${await deadPid()}\n`);
    expect(acquireLock(root)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    fs.writeFileSync(lockFile(root), 'garbage');
    expect(acquireLock(root)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
  });

  it('is shared by every path to the same root', () => {
    if (process.platform === 'win32') return;
    const link = path.join(home, 'link');
    fs.symlinkSync(root, link);
    expect(lockFile(link)).toBe(lockFile(root));
  });
});
