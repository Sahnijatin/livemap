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
import { livemapHome, removeRuntime, runtimeFor, writeRuntime } from './agents/runtime.js';
import { acquireLock, releaseLock, setLockPort } from './lock.js';
import { HistoryStore } from './history/store.js';
import { buildExport, codeWarning } from './export/export.js';
import { loadSummaryConfig } from './summarize/config.js';
import { Summarizer } from './summarize/summarizer.js';
import { AGENT_NAMES, detectAgents, initAgents, installHookScript, removeAgents, type AgentName } from './init.js';

const USAGE = 'Usage: livemap [dir=.] [--port N] [--no-open] [--pull[=SEC]] [--no-history] [--summaries]\n       livemap init [dir=.] [--agents claude,codex,cursor] [--remove]\n       livemap export [dir=.] [--session ID] [--no-code] [--out FILE]';
const DEFAULT_PULL_SEC = 15;

interface Args { dir: string; port: number; open: boolean; pullSec: number | null; history: boolean; summaries: boolean }
interface InitArgs { dir: string; agents?: AgentName[]; remove: boolean }
interface ExportArgs { dir: string; session?: string; code: boolean; out?: string }

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

function parseExportArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = { dir: '.', code: true };
  let sawDir = false;
  const value = (flag: string, v: string | undefined): string => {
    if (!v) fail(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-code') args.code = false;
    else if (a === '--session') args.session = value('--session', argv[++i]);
    else if (a.startsWith('--session=')) args.session = value('--session', a.slice('--session='.length));
    else if (a === '--out') args.out = value('--out', argv[++i]);
    else if (a.startsWith('--out=')) args.out = value('--out', a.slice('--out='.length));
    else if (a === '-h' || a === '--help') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else if (sawDir) fail(`unexpected argument: ${a}`);
    else { args.dir = a; sawDir = true; }
  }
  return args;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: '.', port: DEFAULT_PORT, open: true, pullSec: null, history: true, summaries: false };
  let sawDir = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') args.open = false;
    else if (a === '--no-history') args.history = false;
    else if (a === '--summaries') args.summaries = true;
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

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `livemap-<name>-<YYYYMMDD-HHmm>.html`, in local time. */
function exportName(name: string, d = new Date()): string {
  return `livemap-${name}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.html`;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Writes a self-contained HTML replay of the recorded history; needs no running server. */
async function runExport(argv: string[]): Promise<void> {
  const args = parseExportArgs(argv);
  const root = resolveRoot(args.dir);
  const uiFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-export', 'index.html');
  let uiHtml: string;
  try {
    uiHtml = fs.readFileSync(uiFile, 'utf8');
  } catch {
    fail(`the export UI is not built (${uiFile} is missing)`);
  }
  let res: Awaited<ReturnType<typeof buildExport>>;
  try {
    res = await buildExport(root, { session: args.session, code: args.code, uiHtml });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  const out = path.resolve(args.out ?? exportName(path.basename(root)));
  try {
    fs.writeFileSync(out, res.html);
  } catch (e) {
    process.stderr.write(`livemap: could not write ${out}: ${(e as Error).message}\n`);
    process.exit(1);
  }
  if (args.code && res.files > 0) process.stdout.write(`${codeWarning(res.files)}\n`);
  process.stdout.write(`Wrote ${out} (${formatSize(Buffer.byteLength(res.html))})\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') return runInit(argv.slice(1));
  if (argv[0] === 'export') return runExport(argv.slice(1));
  const args = parseArgs(argv);
  const root = resolveRoot(args.dir);
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

  // One LiveMap per project: a second one would overwrite the first's history and runtime entry.
  let lock: Awaited<ReturnType<typeof acquireLock>> = { ok: true };
  let locked = false;
  try {
    lock = await acquireLock(root);
    locked = lock.ok;
  } catch (e) {
    process.stderr.write(`livemap: warning: could not take the project lock: ${(e as Error).message}\n`);
  }
  if (!lock.ok) {
    const rt = runtimeFor(root);
    const at = rt?.pid === lock.pid ? ` at http://127.0.0.1:${rt.port}` : '';
    process.stderr.write(`LiveMap is already running for this project (pid ${lock.pid})${at}\n`);
    process.exit(1);
  }
  process.on('exit', () => releaseLock(root));

  const model = new ProjectModel(root);
  const watcher = new Watcher(model);
  watcher.on('error', (e: Error) => process.stderr.write(`livemap: watcher error: ${e.message}\n`));
  const hub = new AgentHub(root);
  const attributor = new Attributor(hub);
  // A store that cannot open comes back disabled with the reason, which the UI then shows.
  const history = args.history ? await HistoryStore.open(root) : undefined;
  const historyError = history?.info().error;
  if (historyError) process.stderr.write(`livemap: warning: history is unavailable: ${historyError}\n`);

  // Summaries are opt-in: config.json `summaries.enabled` or --summaries; a key in the environment alone never enables them.
  const home = livemapHome();
  const summaryConfig = loadSummaryConfig({ env: process.env, home, flag: args.summaries });
  const summarizer = 'disabled' in summaryConfig ? undefined : new Summarizer(summaryConfig, { home });
  if ('disabled' in summaryConfig && summaryConfig.reason === 'bad-config') {
    const why = summaryConfig.detail ?? 'could not be read or has an invalid "summaries" setting';
    process.stderr.write(`livemap: warning: summaries are off: ${path.join(home, 'config.json')}: ${why}\n`);
  } else if ('disabled' in summaryConfig && summaryConfig.reason === 'no-key') {
    process.stderr.write('livemap: warning: summaries are off: no API key (set summaries.apiKey in config.json, ANTHROPIC_API_KEY or OPENAI_API_KEY)\n');
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ model, watcher, port: args.port, uiDir, hub, attributor, history, summarizer, warn: m => process.stderr.write(`livemap: warning: ${m}\n`) });
  } catch (e) {
    fail(`could not start server: ${(e as Error).message}`);
  }
  // The port lets a later start tell this run from an unrelated process that reuses its pid after a crash.
  if (locked) {
    try {
      if (!setLockPort(root, server.port)) {
        // Another start replaced the lock meanwhile: it owns this project, so leave its runtime entry alone.
        locked = false;
        process.stderr.write('livemap: warning: another LiveMap took over the project lock; agent hooks may not reach this run\n');
      }
    } catch (e) {
      process.stderr.write(`livemap: warning: could not record the port in the project lock: ${(e as Error).message}\n`);
    }
  }
  // Hooks find this server through the runtime file; it must not outlive the process.
  process.on('exit', () => removeRuntime(root));
  try {
    // Holding the lock makes this the only LiveMap here; without it (lock unavailable) another may own the entry.
    writeRuntime(root, server.port, server.token, { takeover: locked });
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
      summarizer?.stop();
      attributor.stop();
      hub.stop();
      await watcher.stop();
      await server.close();
      await history?.close(); // flushes buffered records
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  process.stdout.write(`LiveMap is watching ${path.basename(root)}\n  ${server.url}\n`);
  // Open now so the browser shows indexing progress instead of waiting for the scan (spec §13).
  if (args.open) openBrowser(server.launchUrl());

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
