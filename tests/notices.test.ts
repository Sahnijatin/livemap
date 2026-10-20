import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script without types
import { allowed, collect, grammars, GRAMMAR_SOURCES, render, shipped } from '../scripts/notices.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

describe('third-party notices', () => {
  it('allows listed licenses and SPDX expressions with one allowed side of an OR', () => {
    expect(allowed('MIT')).toBe(true);
    expect(allowed('EPL-2.0 OR GPL-3.0-or-later')).toBe(true);
    expect(allowed('(MIT OR CC0-1.0)')).toBe(true);
    expect(allowed('MIT AND GPL-3.0-only')).toBe(false);
    expect(allowed('GPL-3.0-only')).toBe(false);
    expect(allowed('SEE LICENSE IN LICENSE')).toBe(false);
    expect(allowed(null)).toBe(false);
  });

  it('lists production packages only: no root, no dev or dev-optional ones', () => {
    const lock = { packages: {
      '': { name: 'app' },
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/a/node_modules/@s/b': { version: '2.0.0', license: 'ISC' },
      'node_modules/vite': { version: '5.0.0', license: 'MIT', dev: true },
      'node_modules/@esbuild/linux-x64': { version: '0.21.0', license: 'MIT', devOptional: true },
    } };
    expect(shipped(lock, '/x').map((p: { name: string }) => p.name)).toEqual(['a', '@s/b']);
  });

  it('every grammar the engine loads has a license and source', () => {
    const list = grammars(fs.readFileSync(path.join(repo, 'src/engine/languages.ts'), 'utf8'));
    expect(list.length).toBeGreaterThan(10);
    for (const g of list) expect(GRAMMAR_SOURCES[g], g).toBeDefined();
  });

  it('the repo passes the license check, and the notices name elkjs with its source', () => {
    const result = collect(repo);
    expect(result.problems).toEqual([]);
    const elk = result.ui.find((p: { name: string }) => p.name === 'elkjs');
    expect(elk).toMatchObject({ source: 'https://github.com/kieler/elkjs' });
    const text = render(result);
    expect(text).toContain('| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later | https://github.com/kieler/elkjs |');
    expect(text).toContain('| tree-sitter-typescript | MIT | https://github.com/tree-sitter/tree-sitter-typescript |');
    expect(text).not.toMatch(/—/);
  });

  it('flags a disallowed license, and an EPL package without a source link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-notices-'));
    fs.mkdirSync(path.join(dir, 'ui'));
    fs.mkdirSync(path.join(dir, 'src/engine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/engine/languages.ts'), "export const GRAMMAR = { cobol: 'cobol' };\n");
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/gpl': { version: '1.0.0', license: 'GPL-3.0-only' } } }));
    fs.writeFileSync(path.join(dir, 'ui/package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/eclipse': { version: '1.0.0', license: 'EPL-2.0' } } }));
    expect(collect(dir).problems).toEqual([
      'eclipse@1.0.0: EPL-2.0 needs a source link in SOURCES',
      'gpl@1.0.0: license GPL-3.0-only is not on the allowlist',
      'tree-sitter-cobol: add its license and source to GRAMMAR_SOURCES in scripts/notices.mjs',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
