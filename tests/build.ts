import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = path.join(repo, 'node_modules', '.livemap-test-build');
const stamp = `${lock}.done`;
// Test files run in worker processes forked by one vitest process: its pid identifies this run.
const runId = String(process.ppid);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const builtThisRun = () => { try { return fs.readFileSync(stamp, 'utf8') === runId; } catch { return false; } };

/** With LIVEMAP_TEST_PREBUILT=1 (CI builds before `npm test`), a complete existing build is used as is. */
export function usePrebuilt(dir = repo, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVEMAP_TEST_PREBUILT === '1'
    && ['dist/cli.js', 'dist/ui/index.html', 'dist/ui-export/index.html'].every(f => fs.existsSync(path.join(dir, f)));
}

/**
 * Runs `npm run build` once per test run even when several test files ask for it: a second build
 * would delete dist/ output while another file's CLI tests are using it. The builder holds a lock
 * directory; the others wait for it, then see the stamp and skip. Skipped with usePrebuilt().
 */
export async function buildOnce(): Promise<void> {
  if (usePrebuilt()) return;
  for (;;) {
    if (builtThisRun()) return;
    try {
      fs.mkdirSync(lock);
    } catch {
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > 120_000) fs.rmSync(lock, { recursive: true, force: true }); // stale
      else await sleep(100);
      continue;
    }
    try {
      if (!builtThisRun()) {
        execSync('npm run build', { cwd: repo, stdio: 'ignore' });
        fs.writeFileSync(stamp, runId);
      }
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}
