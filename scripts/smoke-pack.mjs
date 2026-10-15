// Packs LiveMap, installs the tarball into a fresh project under a temp dir whose path contains a
// space, and checks the installed CLI: --help, init, and a running server (npm run smoke, after build).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livemap smoke '));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, LIVEMAP_HOME: path.join(tmp, 'home') };
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function duBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += duBytes(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/** Runs the server until its URL answers, or fails after 5 s. Returns the parsed /api/state. */
async function serve(bin, fixture) {
  const child = spawn(bin, [fixture, '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 5000;
  try {
    for (;;) {
      check(Date.now() < deadline, `server did not answer in 5 s:\n${out}`);
      check(child.exitCode === null, `server exited with ${child.exitCode}:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=([\w-]+)/.exec(out);
      if (!m) continue;
      const base = new URL(m[0]);
      const page = await fetch(base);
      check(page.status === 200, `GET / answered ${page.status}`);
      const state = await fetch(new URL(`/api/state?t=${m[1]}`, base));
      if (state.status === 503) continue; // still indexing
      check(state.status === 200, `GET /api/state answered ${state.status}`);
      return await state.json();
    }
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  }
}

async function main() {
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', tmp], { cwd: repo, encoding: 'utf8' }));
  const tarball = path.join(tmp, packed.filename);
  console.log(`smoke: ${packed.filename}: ${packed.entryCount} files, ${mb(packed.size)} packed, ${mb(packed.unpackedSize)} unpacked`);

  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), '{ "name": "smoke", "private": true }\n');
  execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: app, stdio: 'ignore' });
  console.log(`smoke: installed node_modules ${mb(duBytes(path.join(app, 'node_modules')))}`);
  const bin = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'livemap.cmd' : 'livemap');

  const help = spawnSync(bin, ['--help'], { env, encoding: 'utf8' });
  check(help.status === 0 && help.stdout.includes('Usage: livemap'), `livemap --help failed (${help.status}):\n${help.stdout}${help.stderr}`);

  const fixture = path.join(tmp, 'fixture project');
  fs.cpSync(path.join(repo, 'tests', 'fixtures', 'js'), fixture, { recursive: true });
  const init = spawnSync(bin, ['init', fixture, '--agents', 'claude'], { env, encoding: 'utf8' });
  check(init.status === 0, `livemap init failed (${init.status}):\n${init.stdout}${init.stderr}`);
  const settings = JSON.parse(fs.readFileSync(path.join(fixture, '.claude', 'settings.local.json'), 'utf8'));
  const commands = Object.values(settings.hooks).flat().flatMap((e) => e.hooks).map((h) => h.command);
  check(commands.length > 0, 'init wrote no hook commands');
  for (const command of commands) {
    const quoted = /^node '((?:[^']|'\\'')*)' /.exec(command) ?? /^node "([^"]*)" /.exec(command);
    const hook = quoted?.[1].replace(/'\\''/g, "'");
    check(hook && fs.existsSync(hook), `hook command points at a missing file: ${command}`);
  }

  const state = await serve(bin, fixture);
  check(state.files.length > 0, '/api/state returned no files');
  check(state.files.some((f) => f.symbols.length > 0), '/api/state has no symbols (grammars did not load)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('smoke: ok');
}

main().catch((e) => {
  console.error(`smoke: failed (kept ${tmp})\n${e.message}`);
  process.exit(1);
});
