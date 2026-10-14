import { describe, it, expect } from 'vitest';
import { openBrowser, isOpenableUrl } from '../../src/server/open.js';

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
