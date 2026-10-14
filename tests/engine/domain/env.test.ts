import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFile } from '../../../src/engine/domain/index.js';
import { env } from '../../../src/engine/domain/env.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/env/', import.meta.url));
const read = (name: string): string => fs.readFileSync(path.join(DIR, name), 'utf8');
const run = (rel: string, text: string): string[] => analyzeFile(rel, langOf(rel), text, [env]).env;

describe('env analyzer', () => {
  const cases: Record<string, string[]> = {
    'server.ts': ['DATABASE_URL', 'DENO_TOKEN', 'STRIPE_KEY', 'VITE_MODE'],
    'settings.py': ['PY_A', 'PY_B', 'PY_C'],
    'main.go': ['GO_HOST', 'GO_PORT'],
    'main.rs': ['RS_A', 'RS_B'],
    'config.rb': ['RB_A', 'RB_B'],
    'config.php': ['APP_KEY', 'PHP_A', 'PHP_B'],
    'App.kt': ['KT_A'],
    'App.java': ['JAVA_A'],
  };
  for (const [file, names] of Object.entries(cases)) {
    it(`reads env usages in ${file}, skipping comments and dynamic keys`, () => {
      expect(run(file, read(file))).toEqual(names);
    });
  }

  it('ignores dynamic keys', () => {
    expect(run('a.ts', 'const k = "X";\nprocess.env[k];\nprocess.env[`A_${k}`];\n')).toEqual([]);
  });

  it('reads .env.example keys, skipping commented ones', () => {
    expect(read('.env.example')).toBe('A=1\n# B=2\nexport C=3\n');
    expect(run('.env.example', read('.env.example'))).toEqual(['A', 'C']);
    expect(run('config/.env.sample', 'X=1\n')).toEqual(['X']);
    expect(run('.env.template', 'Y=\n')).toEqual(['Y']);
  });

  it('does not apply to secret env files or non-code files', () => {
    expect(env.applies('.env.local', langOf('.env.local'))).toBe(false);
    expect(env.applies('.env', langOf('.env'))).toBe(false);
    expect(env.applies('README.md', 'markdown')).toBe(false);
    expect(env.applies('.env.example', langOf('.env.example'))).toBe(true);
    expect(env.applies('src/a.ts', 'typescript')).toBe(true);
  });

  it('dedupes and sorts names', () => {
    expect(run('a.js', 'process.env.B; process.env.A; process.env.B;\n')).toEqual(['A', 'B']);
  });
});
