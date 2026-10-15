import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grammarPath } from '../../src/engine/parser.js';
import { GRAMMAR } from '../../src/engine/languages.js';
import { buildOnce } from '../build.js';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

describe('grammarPath', () => {
  beforeAll(buildOnce, 300_000);

  it('resolves tree-sitter-wasms in a source tree', () => {
    const p = grammarPath('typescript');
    expect(p).toMatch(/tree-sitter-wasms[\\/]out[\\/]tree-sitter-typescript\.wasm$/);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('resolves dist/grammars next to cli.js in a built tree', () => {
    const p = grammarPath('typescript', dist);
    expect(p).toBe(path.join(dist, 'grammars', 'tree-sitter-typescript.wasm'));
    expect(fs.existsSync(p)).toBe(true);
  });

  it('the build copies exactly the grammars LiveMap loads', () => {
    const want = [...new Set(Object.values(GRAMMAR))].map(g => `tree-sitter-${g}.wasm`).sort();
    expect(fs.readdirSync(path.join(dist, 'grammars')).sort()).toEqual(want);
  });
});
