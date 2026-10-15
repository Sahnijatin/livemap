// Installs the UI's dependencies when they are missing or older than its lockfile (prebuild).
import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const lock = 'ui/package-lock.json';
const installed = 'ui/node_modules/.package-lock.json';
const stale = !existsSync(installed) || (existsSync(lock) && statSync(lock).mtimeMs > statSync(installed).mtimeMs);
if (stale) execSync(existsSync(lock) ? 'npm --prefix ui ci' : 'npm --prefix ui install', { stdio: 'inherit' });
