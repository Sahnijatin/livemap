// Usage: node scripts/gen-big.mjs <dir> [count=5000]
// Generates <count> TypeScript files (40 lines, 3 functions, 2 relative imports each).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const n = Number(process.argv[3] ?? 5000);
if (!dir || !Number.isInteger(n) || n < 1) {
  console.error('usage: node scripts/gen-big.mjs <dir> [count]');
  process.exit(1);
}
const PER_DIR = 100;
const rel = (i) => `m${Math.floor(i / PER_DIR)}/f${i}`;

for (let i = 0; i < n; i++) {
  const file = path.join(dir, `${rel(i)}.ts`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const a = (i + 1) % n, b = (i + 7) % n;
  const from = (j) => path.posix.relative(path.posix.dirname(rel(i)), rel(j)).replace(/^(?!\.)/, './');
  const lines = [
    `import { fn${a}a } from '${from(a)}';`,
    `import { fn${b}b } from '${from(b)}';`,
    '',
  ];
  for (const [k, suffix] of [['a', 'a'], ['b', 'b'], ['c', 'c']]) {
    lines.push(`export function fn${i}${suffix}(x: number): number {`);
    lines.push(`  const y = x + ${i};`);
    for (let j = 0; j < 6; j++) lines.push(`  if (y > ${j * 10}) { void '${k}${j}'; }`);
    lines.push(k === 'a' ? `  return y + fn${a}a(x) * 0;` : k === 'b' ? `  return y + fn${b}b(x) * 0;` : '  return y;');
    lines.push('}', '');
  }
  while (lines.length < 40) lines.push(`// padding ${lines.length}`);
  fs.writeFileSync(file, lines.slice(0, 40).join('\n') + '\n');
}
console.log(`generated ${n} files in ${dir}`);
