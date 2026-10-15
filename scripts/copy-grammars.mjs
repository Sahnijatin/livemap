// Copies the tree-sitter grammars LiveMap loads (GRAMMAR in src/engine/languages.ts) to dist/grammars/,
// so the package ships those 15 files instead of depending on all of tree-sitter-wasms.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const src = readFileSync('src/engine/languages.ts', 'utf8');
const body = /export const GRAMMAR\b[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1];
const grammars = [...new Set([...(body ?? '').matchAll(/:\s*'([\w-]+)'/g)].map(m => m[1]))];
if (grammars.length === 0) throw new Error('copy-grammars: GRAMMAR not found in src/engine/languages.ts');

const out = 'dist/grammars';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const g of grammars) {
  const file = `tree-sitter-${g}.wasm`;
  copyFileSync(require.resolve(`tree-sitter-wasms/out/${file}`), path.join(out, file));
}
console.log(`copy-grammars: ${grammars.length} grammars to ${out}`);
