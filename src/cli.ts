import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectModel } from './engine/project.js';
import { Watcher } from './engine/watcher.js';
import { startServer, DEFAULT_PORT } from './server/server.js';
import { openBrowser } from './server/open.js';
import { AgentHub } from './agents/hub.js';
import { Attributor } from './agents/attribution.js';
import { GitWatcher } from './agents/git.js';
import { removeRuntime, writeRuntime } from './agents/runtime.js';
import { AGENT_NAMES, detectAgents, initAgents, installHookScript, removeAgents, type AgentName } from './init.js';

const USAGE = 'Usage: livemap [dir=.] [--port N] [--no-open] [--pull[=SEC]]\n       livemap init [dir=.] [--agents claude,codex,cursor] [--remove]';
const DEFAULT_PULL_SEC = 15;

interface Args { dir: string; port: number; open: boolean; pullSec: number | null }
interface InitArgs { dir: string; agents?: AgentName[]; remove: boolean }

function fail(message: string): never {
  process.stderr.write(`livemap: ${message}\n${USAGE}\n`);
  process.exit(1);
}

function parsePort(v: string | undefined): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) > 65535) fail(`invalid port: ${v ?? '(missing)'}`);
  return Number(v);
}

function parsePull(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 5 || Number(v) > 3600) fail(`invalid --pull interval: ${v} (seconds, 5 to 3600)`);
  return Number(v);
}

function parseAgents(v: string | undefined): AgentName[] {
  const names = (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) fail('--agents needs a list: claude,codex,cursor');
  for (const n of names) if (!(AGENT_NAMES as string[]).includes(n)) fail(`unknown agent: ${n}`);
  return [...new Set(names)] as AgentName[];
}

function parseInitArgs(argv: string[]): InitArgs {
  const args: InitArgs = { dir: '.', remove: false };
  let sawDir = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remove') args.remove = true;
    else if (a === '--agents') args.agents = parseAgents(argv[++i]);
    else if (a.startsWith('--agents=')) args.agents = parseAgents(a.slice('--agents='.length));
    else if (a === '-h' || a === '--help') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else if (sawDir) fail(`unexpected argument: ${a}`);
    else { args.dir = a; sawDir = true; }
  }
  return args;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: '.', port: DEFAULT_PORT, open: true, pullSec: null };
  let sawDir = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') args.open = false;
    else if (a === '--pull') args.pullSec = DEFAULT_PULL_SEC;
    else if (a.startsWith('--pull=')) args.pullSec = parsePull(a.slice('--pull='.length));
    else if (a === '--port') args.port = parsePort(argv[++i]);
    else if (a.startsWith('--port=')) args.port = parsePort(a.slice('--port='.length));
    else if (a === '-h' || a === '--help') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else if (sawDir) fail(`unexpected argument: ${a}`);
    else { args.dir = a; sawDir = true; }
  }
  return args;
}

function resolveRoot(dir: string): string {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(dir));
  } catch {
    fail(`directory not found: ${dir}`);
  }
  if (!fs.statSync(root).isDirectory()) fail(`not a directory: ${dir}`);
  return root;
}

function runInit(argv: string[]): void {
  const args = parseInitArgs(argv);
  const root = resolveRoot(args.dir);
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const report = (r: { file: string; action: string; reason?: string }) => say(r.reason ? `${r.action} ${r.file}: ${r.reason}` : `${r.action} ${r.file}`);

  if (args.remove) {
    const results = removeAgents(root, { agents: args.agents });
    if (!results.length) say('No LiveMap hooks found.');
    results.forEach(report);
    if (results.length && results.every(r => r.action === 'skipped')) process.exit(1);
    return;
  }
  const agents = args.agents ?? detectAgents(root);
  if (!agents.length) {
    process.stderr.write('No agents detected. Use --agents claude,codex,cursor.\n');
    process.exit(1);
  }
  const results = initAgents(root, { agents, hookPath: installHookScript() });
  results.forEach(report);
  if (results.some(r => r.agent === 'codex' && r.action !== 'skipped')) say('Codex: run /hooks inside Codex once to trust the LiveMap hook.');
  if (results.every(r => r.action === 'skipped')) process.exit(1); // nothing could be configured
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') return runInit(argv.slice(1));
  const args = parseArgs(argv);
  const root = resolveRoot(args.dir);
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

  const model = new ProjectModel(root);
  const watcher = new Watcher(model);
  watcher.on('error', (e: Error) => process.stderr.write(`livemap: watcher error: ${e.message}\n`));
  const hub = new AgentHub(root);
  const attributor = new Attributor(hub);

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ model, watcher, port: args.port, uiDir, hub, attributor });
  } catch (e) {
    fail(`could not start server: ${(e as Error).message}`);
  }
  // Hooks find this server through the runtime file; it must not outlive the process.
  process.on('exit', () => removeRuntime(root));
  try {
    writeRuntime(root, server.port, server.token);
  } catch (e) {
    process.stderr.write(`livemap: could not write runtime file, agent hooks will not reach this run: ${(e as Error).message}\n`);
  }
  hub.startDiscovery();
  const git = new GitWatcher(root, { pullSec: args.pullSec });
  git.on('events', evs => hub.ingestRaw(evs, { agent: 'git', cwd: root, hooks: false }));
  git.on('error', (e: Error) => process.stderr.write(`livemap: git: ${e.message}\n`));
  void git.start(); // not awaited: git must never delay indexing

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) process.exit(0); // second signal: stop waiting
    stopping = true;
    removeRuntime(root);
    setTimeout(() => process.exit(0), 3000).unref(); // failsafe if cleanup hangs
    try {
      git.stop();
      attributor.stop();
      hub.stop();
      await watcher.stop();
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  process.stdout.write(`LiveMap is watching ${path.basename(root)}\n  ${server.url}\n`);
  // Open now so the browser shows indexing progress instead of waiting for the scan (spec §13).
  if (args.open) openBrowser(server.url);

  // Watch before scanning: edits made during the scan queue behind it in the model (update is
  // serialized after scan), and the server only records changes until ready().
  await watcher.start();
  if (stopping) return;
  await model.scan((done, total) => server.setIndexing(done, total));
  if (stopping) return;
  if (model.truncated) process.stderr.write(`livemap: indexed the first ${model.limit} files only\n`);
  server.ready();
}

main().catch(e => {
  process.stderr.write(`livemap: ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
