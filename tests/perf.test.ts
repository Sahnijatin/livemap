import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ProjectModel } from '../src/engine/project';

const COUNT = 5000;
const MAX_SCAN_MS = 15_000;
const MAX_RSS_MB = 500;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-perf-'));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/gen-big.mjs', import.meta.url)), dir, String(COUNT)], { stdio: 'ignore' });
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('scan of 5,000 files finishes in under 15 s and stays under 500 MB RSS', async () => {
  const model = new ProjectModel(dir);
  // Peak RSS is sampled (bytes on every platform) instead of resourceUsage().maxRSS, whose unit
  // has differed across platforms/libuv versions and which also covers memory used before the scan.
  let peak = process.memoryUsage().rss;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  let ms: number;
  try {
    const t0 = performance.now();
    await model.scan();
    ms = performance.now() - t0;
  } finally {
    clearInterval(sample);
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  const mb = peak / (1024 * 1024);
  console.log(`PERF scan ${COUNT} files: ${Math.round(ms)} ms, peak RSS ${mb.toFixed(0)} MB`);
  expect(model.all().length).toBe(COUNT);
  expect(ms).toBeLessThan(MAX_SCAN_MS);
  expect(mb).toBeLessThan(MAX_RSS_MB);
});
