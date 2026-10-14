import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, isOpenableUrl, browserCommand } from '../../src/server/open.js';

describe('openBrowser', () => {
  it('never throws, even when no opener command exists', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => openBrowser('http://127.0.0.1:1/?t=x')).not.toThrow();
      // Let a late spawn 'error' event fire; an unhandled one would fail the run.
      await new Promise(r => setTimeout(r, 100));
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('isOpenableUrl', () => {
  it('accepts only loopback LiveMap URLs', () => {
    expect(isOpenableUrl('http://127.0.0.1:4317/?t=0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isOpenableUrl('http://127.0.0.1:4317/')).toBe(true);
    for (const bad of [
      'https://127.0.0.1:4317/', 'http://localhost:4317/', 'http://127.0.0.1:4317/?t=XYZ',
      'http://127.0.0.1:4317/?t=ab&x=1', 'http://127.0.0.1:4317/?t=ab" & calc', 'file:///etc/passwd',
      'http://127.0.0.1:4317/\n', 'http://evil.example/',
    ]) expect(isOpenableUrl(bad), bad).toBe(false);
  });
});

describe('browserCommand', () => {
  const url = 'http://127.0.0.1:4317/?t=0123456789abcdef0123456789abcdef';

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: keeps the token out of the opener's arguments via a private launcher file`, () => {
      const l = browserCommand(url, platform)!;
      try {
        expect(l.cmd).toBe(platform === 'darwin' ? 'open' : 'xdg-open');
        expect(l.args.join(' ')).not.toContain('0123456789abcdef');
        const file = l.args[0];
        expect(file).toMatch(/\.html$/);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        const html = fs.readFileSync(file, 'utf8');
        expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${url}">`);
      } finally {
        l.cleanup();
      }
      expect(fs.existsSync(path.dirname(l.args[0]))).toBe(false);
    });
  }

  it('opens a tokenless URL directly', () => {
    const l = browserCommand('http://127.0.0.1:4317/', 'linux')!;
    expect(l.args).toEqual(['http://127.0.0.1:4317/']);
    l.cleanup();
  });

  it('rejects URLs that are not LiveMap loopback URLs', () => {
    expect(browserCommand('http://evil.example/', 'linux')).toBeNull();
  });
});
