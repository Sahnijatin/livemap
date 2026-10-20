#!/usr/bin/env node
/**
 * `npm run plugin:sync`: copies the built SkyForge plugin (dist/livemap-skyforge.js, from `npm run build`) to
 * plugins/servicenow/skyforge-plugin/livemap-skyforge.js, the committed copy. A test fails when they differ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'dist', 'livemap-skyforge.js');
const to = path.join(root, 'plugins', 'servicenow', 'skyforge-plugin', 'livemap-skyforge.js');
if (!fs.existsSync(from)) {
  process.stderr.write('dist/livemap-skyforge.js is missing: run npm run build first\n');
  process.exit(1);
}
fs.copyFileSync(from, to);
process.stdout.write(`Copied ${path.relative(root, from)} to ${path.relative(root, to)}\n`);
