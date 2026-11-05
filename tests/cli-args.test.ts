import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseArgs, readVersion } from '../src/cli-args.js';

describe('parseArgs --pull', () => {
  it('reads --pull 30 with a space and keeps the default dir', () => {
    expect(parseArgs(['--pull', '30'])).toMatchObject({ pullSec: 30, dir: '.' });
  });
  it('keeps ./30 as a folder after --pull', () => {
    expect(parseArgs(['--pull', './30'])).toMatchObject({ pullSec: 15, dir: './30' });
  });
  it('reads --pull=45', () => {
    expect(parseArgs(['--pull=45'])).toMatchObject({ pullSec: 45, dir: '.' });
  });
});

describe('readVersion', () => {
  it('returns the version from package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });
});
