import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseArgs, metaCommand, readVersion } from '../src/cli-args.js';

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

describe('metaCommand', () => {
  it('reads --version, -v, -V and version', () => {
    for (const a of ['--version', '-v', '-V', 'version']) expect(metaCommand([a])).toBe('version');
  });
  it('reads help as a command, not a folder', () => {
    expect(metaCommand(['help'])).toBe('help');
  });
  it('leaves folders, options and later arguments alone', () => {
    expect(metaCommand([])).toBeNull();
    expect(metaCommand(['./help'])).toBeNull();
    expect(metaCommand(['.', '--version'])).toBeNull();
    expect(metaCommand(['--no-open'])).toBeNull();
  });
});

describe('readVersion', () => {
  it('is the version in package.json', () => {
    expect(readVersion()).toBe(JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  });
});
