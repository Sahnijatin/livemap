import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

// Use the preinstalled Chromium when present (override with LIVEMAP_CHROMIUM);
// otherwise Playwright's own browser is used.
const candidate = process.env.LIVEMAP_CHROMIUM ?? '/opt/pw-browsers/chromium';
const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const executablePath = isFile(candidate) ? candidate : undefined;
// Chromium cannot use its sandbox as root (containers, CI); keep it on for normal users.
const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: sandbox },
  },
});
