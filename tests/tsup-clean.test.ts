import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Options } from 'tsup';
import configs from '../tsup.config';

// tsup's own glob, resolved from tsup, as it deletes `**/*` plus the `clean` patterns (removeFiles).
const { glob } = createRequire(createRequire(import.meta.url).resolve('tsup'))('tinyglobby') as typeof import('tinyglobby');

const OUTPUT = ['cli.js', 'cli.js.map', 'hook.mjs', 'THIRD_PARTY_NOTICES.md', 'ui/index.html', 'ui/assets/cli.js', 'ui-export/index.html', 'grammars/tree-sitter-go.wasm'];
let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('tsup clean (#63)', () => {
  it('each build deletes only its own top-level output, never the UI, export or grammar builds', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-tsup-clean-'));
    for (const f of OUTPUT) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    const list = configs as Options[];
    expect(list).toHaveLength(2);
    const deleted = await Promise.all(list.map(async c => {
      expect(Array.isArray(c.clean), 'clean must be a pattern list: `true` would empty dist/').toBe(true);
      return (await glob(['**/*', ...(c.clean as string[])], { cwd: dir })).sort();
    }));
    expect(deleted).toEqual([['cli.js', 'cli.js.map'], ['hook.mjs']]);
  });
});
