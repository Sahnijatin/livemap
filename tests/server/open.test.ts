import { describe, it, expect } from 'vitest';
import { browserWords, openBrowser, isOpenableUrl, openerFor } from '../../src/server/open.js';

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
  const none = () => false;
  it('runs BROWSER with the URL as its last argument', () => {
    expect(openerFor(url, 'linux', { BROWSER: '/usr/bin/firefox' }, none)).toEqual({ cmd: '/usr/bin/firefox', args: [url], opts: {} });
    expect(openerFor(url, 'win32', { BROWSER: 'C:\\Apps\\chrome.exe' }, none)).toEqual({ cmd: 'C:\\Apps\\chrome.exe', args: [url], opts: {} });
    expect(openerFor(url, 'darwin', { BROWSER: '  ' }, none)).toEqual({ cmd: 'open', args: [url], opts: {} });
  });
  it('passes BROWSER arguments, and puts the URL where %s stands', () => {
    expect(openerFor(url, 'linux', { BROWSER: 'chrome --incognito' }, none)).toEqual({ cmd: 'chrome', args: ['--incognito', url], opts: {} });
    expect(openerFor(url, 'linux', { BROWSER: 'firefox -new-tab %s --foreground' }, none)).toEqual({ cmd: 'firefox', args: ['-new-tab', url, '--foreground'], opts: {} });
    expect(openerFor(url, 'win32', { BROWSER: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --new-window' }, none))
      .toEqual({ cmd: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--new-window', url], opts: {} });
  });
  it('treats a BROWSER that is an existing file as one program, spaces and all', () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    expect(openerFor(url, 'win32', { BROWSER: chrome }, p => p === chrome)).toEqual({ cmd: chrome, args: [url], opts: {} });
  });
  it('splits words on spaces outside quotes, keeping backslashes', () => {
    expect(browserWords(`a "b c" 'd e' C:\\x\\y.exe ""`)).toEqual(['a', 'b c', 'd e', 'C:\\x\\y.exe', '']);
  });
  it('opens nothing for BROWSER=none, in any case', () => {
    expect(openerFor(url, 'linux', { BROWSER: 'none' }, none)).toBeNull();
    expect(openerFor(url, 'win32', { BROWSER: ' None ' })).toBeNull();
  });
  it('runs a Windows .cmd or .bat BROWSER through cmd, every word quoted', () => {
    const b = 'C:\\My Tools\\open it.cmd';
    expect(openerFor(url, 'win32', { BROWSER: b }, p => p === b)).toEqual({ cmd: 'cmd', args: ['/d', '/s', '/c', `""${b}" "${url}""`], opts: { windowsVerbatimArguments: true } });
    expect(openerFor(url, 'win32', { BROWSER: `"${b}" --x` }, none)).toEqual({ cmd: 'cmd', args: ['/d', '/s', '/c', `""${b}" "--x" "${url}""`], opts: { windowsVerbatimArguments: true } });
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
