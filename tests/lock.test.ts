import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, LOCK_GRACE_MS, lockFile, releaseLock, setLockPort } from '../src/lock.js';

let home: string;
let root: string;
let saved: string | undefined;

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => child.on('exit', r));
  return child.pid as number;
}

async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise(r => srv.close(r));
  return port;
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

  it('is taken with this pid, re-entrant for the same process, and released', async () => {
    expect(await acquireLock(root)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    expect(await acquireLock(root)).toEqual({ ok: true });
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
      expect(await acquireLock(root)).toEqual({ ok: false, pid: other.pid });
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
    expect(await acquireLock(root)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    fs.writeFileSync(lockFile(root), 'garbage');
    expect(await acquireLock(root)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
  });

  describe('a pid reused by an unrelated process (#40)', () => {
    let other: ChildProcess;
    beforeEach(() => {
      other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      fs.mkdirSync(path.dirname(lockFile(root)), { recursive: true });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      other.kill('SIGKILL');
      await new Promise(r => other.on('exit', r));
    });

    it('is stale when nothing listens on the port the lock records', async () => {
      fs.writeFileSync(lockFile(root), JSON.stringify({ pid: other.pid, port: await closedPort() }));
      expect(await acquireLock(root)).toEqual({ ok: true });
      expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    });

    it('is held while something listens on that port', async () => {
      const srv = net.createServer();
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
      try {
        const port = (srv.address() as net.AddressInfo).port;
        fs.writeFileSync(lockFile(root), JSON.stringify({ pid: other.pid, port }));
        expect(await acquireLock(root)).toEqual({ ok: false, pid: other.pid });
      } finally {
        await new Promise(r => srv.close(r));
      }
    });

    it('is stale without a port once it is older than the start-up grace period', async () => {
      fs.writeFileSync(lockFile(root), `${other.pid}\n`);
      const old = (Date.now() - LOCK_GRACE_MS - 1000) / 1000;
      fs.utimesSync(lockFile(root), old, old);
      expect(await acquireLock(root)).toEqual({ ok: true });
      expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    });

    it('is stale when the pid belongs to another user (EPERM)', async () => {
      fs.writeFileSync(lockFile(root), `${other.pid}\n`);
      const kill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
        if (pid === other.pid && sig === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        return kill(pid, sig);
      });
      expect(await acquireLock(root)).toEqual({ ok: true });
      expect(fs.readFileSync(lockFile(root), 'utf8').trim()).toBe(String(process.pid));
    });
  });

  it('keeps a fresh lock another starter took between judging the old one stale and removing it (#40)', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const file = lockFile(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${await deadPid()}\n`);
      // The other starter also saw the dead pid, and removes it and links its own lock right before this one
      // acts on the lock it judged stale (whichever of rename or unlink that is).
      let raced = false;
      const race = (p: fs.PathLike) => {
        if (raced || p !== file) return;
        raced = true;
        fs.rmSync(file);
        fs.writeFileSync(file, `${other.pid}\n`);
      };
      const rename = fs.renameSync.bind(fs);
      const unlink = fs.unlinkSync.bind(fs);
      vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => { race(a); rename(a, b); });
      vi.spyOn(fs, 'unlinkSync').mockImplementation(p => { race(p); unlink(p); });
      expect(await acquireLock(root)).toEqual({ ok: false, pid: other.pid });
      expect(raced).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(`${other.pid}\n`);
      expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    } finally {
      vi.restoreAllMocks();
      other.kill('SIGKILL');
      await new Promise(r => other.on('exit', r));
    }
  });

  it('records the port of the holder, and only of the holder', async () => {
    expect(await acquireLock(root)).toEqual({ ok: true });
    setLockPort(root, 4321);
    expect(JSON.parse(fs.readFileSync(lockFile(root), 'utf8'))).toEqual({ pid: process.pid, port: 4321 });
    expect(await acquireLock(root)).toEqual({ ok: true });
    expect(fs.readdirSync(path.dirname(lockFile(root)))).toEqual([path.basename(lockFile(root))]);
    fs.writeFileSync(lockFile(root), `${process.pid + 1}\n`);
    setLockPort(root, 5555);
    expect(fs.readFileSync(lockFile(root), 'utf8')).toBe(`${process.pid + 1}\n`);
    fs.writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, port: 4321 }));
    releaseLock(root);
    expect(fs.existsSync(lockFile(root))).toBe(false);
  });

  it('is shared by every path to the same root', () => {
    if (process.platform === 'win32') return;
    const link = path.join(home, 'link');
    fs.symlinkSync(root, link);
    expect(lockFile(link)).toBe(lockFile(root));
  });
});
