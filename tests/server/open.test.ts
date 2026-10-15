import { describe, it, expect } from 'vitest';
import { openBrowser, isOpenableUrl, openerFor } from '../../src/server/open.js';

describe('openBrowser', () => {
  it('never throws, even when no opener command exists', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => openBrowser('http://127.0.0.1:1/?launch=ab')).not.toThrow();
      // Let a late spawn 'error' event fire; an unhandled one would fail the run.
      await new Promise(r => setTimeout(r, 100));
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('openerFor', () => {
  const url = 'http://127.0.0.1:4317/?launch=0123456789abcdef0123456789abcdef';
  it('uses each platform default when BROWSER is unset', () => {
    expect(openerFor(url, 'darwin', {})).toEqual({ cmd: 'open', args: [url], opts: {} });
    expect(openerFor(url, 'linux', {})).toEqual({ cmd: 'xdg-open', args: [url], opts: {} });
    expect(openerFor(url, 'win32', {})).toEqual({ cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], opts: { windowsVerbatimArguments: true } });
  });
  it('runs BROWSER with the URL as its one argument', () => {
    expect(openerFor(url, 'linux', { BROWSER: '/usr/bin/firefox' })).toEqual({ cmd: '/usr/bin/firefox', args: [url], opts: {} });
    expect(openerFor(url, 'win32', { BROWSER: 'C:\\Apps\\chrome.exe' })).toEqual({ cmd: 'C:\\Apps\\chrome.exe', args: [url], opts: {} });
    expect(openerFor(url, 'darwin', { BROWSER: '  ' })).toEqual({ cmd: 'open', args: [url], opts: {} });
  });
  it('runs a Windows .cmd or .bat BROWSER through cmd, both quoted', () => {
    const b = 'C:\\My Tools\\open it.cmd';
    expect(openerFor(url, 'win32', { BROWSER: b })).toEqual({ cmd: 'cmd', args: ['/d', '/s', '/c', `""${b}" "${url}""`], opts: { windowsVerbatimArguments: true } });
  });
});

describe('isOpenableUrl', () => {
  it('accepts only loopback LiveMap URLs', () => {
    expect(isOpenableUrl('http://127.0.0.1:4317/?launch=0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isOpenableUrl('http://127.0.0.1:4317/')).toBe(true);
    for (const bad of [
      // The real token never goes to an opener: process arguments are readable by other users.
      'http://127.0.0.1:4317/?t=0123456789abcdef0123456789abcdef',
      'https://127.0.0.1:4317/', 'http://localhost:4317/', 'http://127.0.0.1:4317/?t=XYZ',
      'http://127.0.0.1:4317/?t=ab&x=1', 'http://127.0.0.1:4317/?t=ab" & calc', 'file:///etc/passwd',
      'http://127.0.0.1:4317/\n', 'http://evil.example/',
    ]) expect(isOpenableUrl(bad), bad).toBe(false);
  });
});
