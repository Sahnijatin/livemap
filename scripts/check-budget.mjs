// First-load budget: the entry chunk of the UI build, gzipped at level 9, stays within LIMIT_KB.
// Reads Vite's manifest (dist/ui/.vite/manifest.json), so run `npm run build` first.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const LIMIT_KB = 82.29;
const dist = fileURLToPath(new URL('../dist/ui/', import.meta.url));

let manifest;
try {
  manifest = JSON.parse(readFileSync(dist + '.vite/manifest.json', 'utf8'));
} catch {
  console.error('budget: dist/ui/.vite/manifest.json not found. Run `npm run build` first.');
  process.exit(2);
}
const entry = Object.values(manifest).find(e => e.isEntry);
if (!entry) {
  console.error('budget: no entry chunk in the manifest.');
  process.exit(2);
}
const kb = gzipSync(readFileSync(dist + entry.file), { level: 9 }).length / 1000;
const ok = kb <= LIMIT_KB;
console.log(`main chunk: ${kb.toFixed(2)} kB gzip (limit ${LIMIT_KB})${ok ? '' : ' EXCEEDED'}`);
process.exit(ok ? 0 : 1);
