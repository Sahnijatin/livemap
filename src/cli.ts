import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectModel } from './engine/project.js';
import { Watcher } from './engine/watcher.js';
import { startServer } from './server/server.js';
import { openBrowser } from './server/open.js';
import { AgentHub } from './agents/hub.js';
import { Attributor } from './agents/attribution.js';
import { GitWatcher } from './agents/git.js';
import { livemapHome, removeRuntime, runtimeFor, writeRuntime } from './agents/runtime.js';
import { acquireLock, LockBusyError, lockId, releaseLock, setLockPort } from './lock.js';
import { HistoryStore } from './history/store.js';
import { buildExport, codeWarning } from './export/export.js';
import { loadSummaryConfig } from './summarize/config.js';
import { Summarizer } from './summarize/summarizer.js';
import { SwitchableSummarizer } from './summarize/switch.js';
import { createSettings } from './settings.js';
import { USAGE, fail, metaCommand, parseArgs, readVersion, type Args, type ServeOptions } from './cli-args.js';
import { ANALYZERS } from './engine/domain/index.js';
// The ServiceNow source registers here until the plugin loader (#53) can load it.
import { runServiceNow } from '../plugins/servicenow/cli.js';
import { runMcpProxy } from './proxy/cli.js';
import { runInstallPlugin } from '../plugins/servicenow/skyforge-plugin/install.js';
import { runBackfillSessions } from '../plugins/servicenow/skyforge-plugin/backfill-sessions.js';
import { AGENT_NAMES, detectAgents, initAgents, installHookScript, removeAgents, type AgentName } from './init.js';

interface InitArgs { dir: string; agents?: AgentName[]; remove: boolean }
interface ExportArgs { dir: string; session?: string; code: boolean; out?: string }

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

function resolveRoot(dir: string): string {
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(dir));
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
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-export');
  const uiFile = path.join(uiDir, 'index.html');
  let uiHtml: string;
  try {
    uiHtml = fs.readFileSync(uiFile, 'utf8');
  } catch {
    fail(`the export UI is not built (${uiFile} is missing)`);
  }
  let res: Awaited<ReturnType<typeof buildExport>>;
  try {
    res = await buildExport(root, { session: args.session, code: args.code, uiHtml, grammars: path.join(uiDir, 'grammars') });
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
  const meta = metaCommand(argv);
  if (meta) {
    process.stdout.write(meta === 'version' ? `${readVersion()}\n` : `${USAGE}\n`);
    return;
  }
  if (argv[0] === 'init') return runInit(argv.slice(1));
  if (argv[0] === 'export') return runExport(argv.slice(1));
  if (argv[0] === 'mcp-proxy') return runMcpProxy(argv.slice(1));
  if (argv[0] === 'sn' && argv[1] === 'install-plugin') return runInstallPlugin(argv.slice(2));
  if (argv[0] === 'sn' && argv[1] === 'backfill-sessions') return runBackfillSessions(argv.slice(2));
  if (argv[0] === 'sn') return runServiceNow(argv.slice(1), { serve, resolveRoot });
  const args = parseArgs(argv);
  return serve(resolveRoot(args.dir), args);
}

/**
 * Indexes `root`, serves the UI and watches for changes until SIGINT or SIGTERM. Sources other than a
 * plain folder (the ServiceNow mirror) add analyzers, map changed paths to records for attribution, and
 * name what is watched.
 */
async function serve(root: string, args: Args, opts: ServeOptions = {}): Promise<void> {
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

  // One LiveMap per project: a second one would overwrite the first's history and runtime entry.
  let lock: Awaited<ReturnType<typeof acquireLock>> = { ok: true };
  let locked = false;
  try {
    lock = await acquireLock(root);
    locked = lock.ok;
  } catch (e) {
    if (e instanceof LockBusyError) {
      process.stderr.write('Another LiveMap is starting for this project; try again in a moment\n');
      process.exit(1);
    }
    // The lock file cannot be written (a read-only home, say): run without it rather than not at all.
    process.stderr.write(`livemap: warning: could not take the project lock: ${(e as Error).message}\n`);
  }
  if (!lock.ok) {
    const rt = runtimeFor(root);
    const at = rt?.pid === lock.pid ? ` at http://127.0.0.1:${rt.port}` : '';
    process.stderr.write(`LiveMap is already running for this project (pid ${lock.pid})${at}\n`);
    process.exit(1);
  }
  process.on('exit', () => releaseLock(root));

  const model = new ProjectModel(root, opts.analyzers ? { analyzers: [...ANALYZERS, ...opts.analyzers] } : {});
  const watcher = new Watcher(model);
  watcher.on('error', (e: Error) => process.stderr.write(`livemap: watcher error: ${e.message}\n`));
  const hub = new AgentHub(root);
  const attributor = new Attributor(hub, opts.recordOf ? { recordOf: opts.recordOf } : {});
  // A store that cannot open comes back disabled with the reason, which the UI then shows.
  const history = args.history ? await HistoryStore.open(root) : undefined;
  const historyError = history?.info().error;
  if (historyError) process.stderr.write(`livemap: warning: history is unavailable: ${historyError}\n`);

  // Summaries are opt-in: config.json `summaries.enabled` or --summaries; a key in the environment alone never enables them.
  const home = livemapHome();
  const summaryConfig = loadSummaryConfig({ env: process.env, home, flag: args.summaries });
  // One summarizer for the whole run: Settings switches it on, off or to another provider without a restart.
  const summarizer = new SwitchableSummarizer(cfg => new Summarizer(cfg, { home }), 'disabled' in summaryConfig ? undefined : summaryConfig);
  const settings = createSettings({ home, root, env: process.env, version: readVersion(), flag: args.summaries, apply: cfg => summarizer.set(cfg) });
  if ('disabled' in summaryConfig && summaryConfig.reason === 'bad-config') {
    const why = summaryConfig.detail ?? 'could not be read or has an invalid "summaries" setting';
    process.stderr.write(`livemap: warning: summaries are off: ${path.join(home, 'config.json')}: ${why}\n`);
  } else if ('disabled' in summaryConfig && summaryConfig.reason === 'no-key') {
    process.stderr.write('livemap: warning: summaries are off: no API key (set summaries.apiKey in config.json, ANTHROPIC_API_KEY or OPENAI_API_KEY)\n');
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ model, watcher, port: args.port, uiDir, hub, attributor, history, summarizer, settings, ...(opts.title ? { name: opts.title } : {}), lockId: () => lockId(root), warn: m => process.stderr.write(`livemap: warning: ${m}\n`) });
  } catch (e) {
    fail(`could not start server: ${(e as Error).message}`);
  }
  // The port lets a later start tell this run from an unrelated process that reuses its pid after a crash.
  if (locked) {
    try {
      const state = setLockPort(root, server.port);
      if (state !== 'held') {
        // Another start holds the lock now, or it cannot be read: leave the runtime entry to its owner.
        locked = false;
        process.stderr.write(state === 'lost'
          ? 'livemap: warning: another LiveMap took over the project lock; agent hooks may not reach this run\n'
          : 'livemap: warning: could not read the project lock; agent hooks may not reach this run\n');
      }
    } catch (e) {
      // The lock is still this run's; only its port is unrecorded, so a later start relies on its age.
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
  const git = opts.git === false ? null : new GitWatcher(root, { pullSec: args.pullSec });
  git?.on('events', evs => hub.ingestRaw(evs, { agent: 'git', cwd: root, hooks: false }));
  git?.on('error', (e: Error) => process.stderr.write(`livemap: git: ${e.message}\n`));
  void git?.start(); // not awaited: git must never delay indexing

  let stopping = false;
  /** Sources that write into the folder (the ServiceNow poller): stopped first. */
  const stopListeners: (() => void)[] = [];
  const shutdown = async (): Promise<void> => {
    if (stopping) process.exit(0); // second signal: stop waiting
    stopping = true;
    for (const f of stopListeners.splice(0)) { try { f(); } catch { /* stopping anyway */ } }
    removeRuntime(root);
    setTimeout(() => process.exit(0), 3000).unref(); // failsafe if cleanup hangs
    try {
      git?.stop();
      summarizer.stop();
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

  process.stdout.write(`LiveMap is watching ${opts.title ?? path.basename(root)}\n  ${server.url}\n`);
  // Open now so the browser shows indexing progress instead of waiting for the scan (spec §13).
  if (args.open) openBrowser(server.launchUrl());

  // Watch before scanning: edits made during the scan queue behind it in the model (update is
  // serialized after scan), and the server only records changes until ready().
  await watcher.start();
  if (stopping) return;
  await model.scan((done, total) => server.setIndexing(done, total));
  if (stopping) return;
  if (model.truncated) process.stderr.write(`livemap: indexed the first ${model.limit} files only\n`);
  if (history && opts.beforeRun && history.info().enabled) {
    try {
      await opts.beforeRun({ model, history, say: line => process.stdout.write(`${line}\n`) });
    } catch (e) {
      process.stderr.write(`livemap: warning: ${(e as Error)?.message ?? String(e)}\n`);
    }
    if (stopping) return;
  }
  server.ready();
  if (stopping) return;
  opts.onReady?.({
    setSkewMs: ms => attributor.setSkewMs(ms),
    onRecordGap: listener => { attributor.on('recordGap', listener); },
    setSource: status => server.setSource(status),
    onShutdown: listener => { stopListeners.push(listener); },
  });
}

main().catch(e => {
  process.stderr.write(`livemap: ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
