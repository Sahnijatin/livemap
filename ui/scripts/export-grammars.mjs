// Writes the highlighting grammars and the Oniguruma wasm next to the export page, for `livemap export`
// to embed only those an export needs: grammars/<id>.json (the grammar with the languages it embeds,
// one per name) and grammars/onig.wasm.b64. Run after the export build, which empties its directory.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The grammars of HIGHLIGHTED in src/shared/grammars.ts, and jsx (tests/export checks that each one is built).
const IDS = [
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby',
  'swift', 'c', 'cpp', 'dart', 'vue', 'svelte', 'sql', 'prisma', 'markdown', 'json', 'yaml', 'toml', 'css',
  'html', 'shellscript',
];

const out = fileURLToPath(new URL('../../dist/ui-export/grammars/', import.meta.url));
fs.mkdirSync(out, { recursive: true });

for (const id of IDS) {
  const { default: langs } = await import(`shiki/langs/${id}.mjs`);
  const byName = new Map(langs.map(l => [l.name, l]));
  fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify([...byName.values()]));
}

const wasm = path.join(path.dirname(createRequire(import.meta.url).resolve('shiki/wasm')), 'onig.wasm');
fs.writeFileSync(path.join(out, 'onig.wasm.b64'), fs.readFileSync(wasm).toString('base64'));
