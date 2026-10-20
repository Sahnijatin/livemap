/**
 * `livemap sn`: mirrors a ServiceNow scope through SkyForge's nexus MCP (read-only), then runs LiveMap on
 * the mirror. Registered from core's CLI until the plugin loader (#53) exists; it only uses `CoreHooks`.
 */
import path from 'node:path';
import type { Args, CoreHooks } from '../../src/cli-args.js';
import { DEFAULT_PORT } from '../../src/server/server.js';
import { serviceNowAnalyzer } from './analyzer.js';
import { instanceInfo, pullScope, resolveScope, ScopeNotFoundError } from './backfill.js';
import { layoutMirror } from './mirror.js';
import { DEFAULT_NEXUS_URL, NexusClient, NexusOfflineError, NexusToolError } from './nexus.js';
import { recordResolver } from './records.js';
import { DEFAULT_SKYFORGE_LOG } from './skyforge-log.js';
import { buildTimeline } from './timeline.js';
import { ensureGitignored, historyPath, snRoot, writeHistory, writeMirror } from './writer.js';

export const SN_USAGE = 'Usage: livemap sn [dir=.] --scope NAMESPACE|SYS_ID [--instance NAME] [--nexus URL] [--skyforge-log FILE|none] [--log-window SECONDS] [--port N] [--no-open] [--no-history] [--mirror-only]';

export interface SnArgs {
  dir: string; scope: string; instance?: string; nexus: string;
  port: number; open: boolean; history: boolean; mirrorOnly: boolean;
  /** SkyForge's MCP log for history attribution; null skips it. */
  skyforgeLog: string | null;
  logWindowSec: number;
}

function fail(message: string): never {
  process.stderr.write(`livemap sn: ${message}\n${SN_USAGE}\n`);
  process.exit(1);
}

export function parseSnArgs(argv: string[], onError: (m: string) => never = fail): SnArgs {
  const args: Partial<SnArgs> & { dir: string } = {
    dir: '.', nexus: DEFAULT_NEXUS_URL, port: DEFAULT_PORT, open: true, history: true, mirrorOnly: false,
    skyforgeLog: DEFAULT_SKYFORGE_LOG, logWindowSec: 60,
  };
  let sawDir = false;
  const value = (flag: string, v: string | undefined): string => (v && !v.startsWith('--') ? v : onError(`${flag} needs a value`));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const take = () => value(flag, inline ?? argv[++i]);
    if (flag === '--scope') args.scope = take();
    else if (flag === '--instance') args.instance = take();
    else if (flag === '--nexus') {
      args.nexus = take();
      try { new URL(args.nexus); } catch { onError(`invalid --nexus URL: ${args.nexus}`); }
    } else if (flag === '--skyforge-log') {
      const v = take();
      args.skyforgeLog = v.toLowerCase() === 'none' ? null : v;
    } else if (flag === '--log-window') {
      const v = take();
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 3600) onError(`invalid --log-window (1 to 3600 seconds): ${v}`);
      args.logWindowSec = Number(v);
    } else if (flag === '--port') {
      const v = take();
      if (!/^\d+$/.test(v) || Number(v) > 65535) onError(`invalid port: ${v}`);
      args.port = Number(v);
    } else if (a === '--no-open') args.open = false;
    else if (a === '--no-history') args.history = false;
    else if (a === '--mirror-only') args.mirrorOnly = true;
    else if (a === '-h' || a === '--help') { process.stdout.write(`${SN_USAGE}\n`); process.exit(0); }
    else if (a.startsWith('-')) onError(`unknown option: ${a}`);
    else if (sawDir) onError(`unexpected argument: ${a}`);
    else { args.dir = a; sawDir = true; }
  }
  if (!args.scope) onError('--scope is required (the app namespace, like x_snc_cc_offering, or its sys_scope sys_id)');
  return args as SnArgs;
}

const n = (x: number): string => x.toLocaleString('en-US');
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export async function runServiceNow(argv: string[], core: CoreHooks): Promise<void> {
  const args = parseSnArgs(argv);
  const project = core.resolveRoot(args.dir);
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const client = new NexusClient({ url: args.nexus, instance: args.instance });
  const t0 = Date.now();
  let scope;
  try {
    await client.connect();
    const info = await instanceInfo(client);
    const instance = info?.name ?? args.instance ?? '(the instance nexus is set to)';
    if (args.instance && info?.name && info.name !== args.instance) {
      process.stderr.write(`livemap sn: warning: nexus answered for ${info.name}, not ${args.instance}\n`);
    }
    say(`Instance: ${instance}${info?.release ? ` (${[info.release, info.patch].filter(Boolean).join(' ')})` : ''}`);
    say(`Nexus: ${args.nexus} (${client.transport === 'sse' ? 'SSE' : 'Streamable HTTP'})`);
    scope = await resolveScope(client, args.scope);
    say(`Scope: ${scope.name} (${scope.scope}, sys_id ${scope.sys_id})`);
    say('Pulling records (read-only)...');
    let last = 0;
    const pulled = await pullScope(client, scope, {
      onProgress: (p) => {
        if (!process.stdout.isTTY || Date.now() - last < 250) return;
        last = Date.now();
        process.stdout.write(`\r  ${p.classesDone}/${p.classes} classes, ${n(p.records)} records`);
      },
    });
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    const root = snRoot(project);
    const { files, manifest } = layoutMirror({ instance: info?.name ?? args.instance ?? '', scope, ...pulled, rootAbs: root });
    const res = writeMirror(root, files, manifest);
    const classes = Object.keys(manifest.byClass).length;
    say(`Pulled ${n(pulled.inventory.length)} records in ${n(classes)} classes in ${secs(Date.now() - t0)} (${n(pulled.queries)} queries).`);
    say(`Mirror: ${path.relative(project, path.join(root, scope.scope)) || '.'} (${n(res.written)} files written, ${n(res.unchanged)} unchanged, ${n(res.removed)} removed)`);
    for (const f of pulled.failedClasses) process.stderr.write(`livemap sn: warning: ${f.class}: kept names and dates only (${f.error})\n`);
    const t1 = Date.now();
    const timeline = await buildTimeline(client, scope, pulled.inventory, manifest, { logFile: args.skyforgeLog, windowMs: args.logWindowSec * 1000 });
    writeHistory(root, scope.scope, timeline.doc);
    const h = timeline.history;
    say(`Versions imported: ${n(h.events.length)} (${n(h.versions)} from sys_update_version, ${n(h.events.length - h.versions)} from sys_update_xml) for ${n(h.fromVersions + h.fromUpdateXml)} records in ${secs(Date.now() - t1)} (${n(h.queries)} queries).`);
    for (const w of h.warnings) process.stderr.write(`livemap sn: warning: history: ${w}\n`);
    const c = timeline.doc.counts;
    if (!args.skyforgeLog) say('SkyForge log: skipped (--skyforge-log none).');
    else if (!timeline.log) say(`SkyForge log: not found at ${args.skyforgeLog}; attribution skipped.`);
    else {
      say(`SkyForge log: ${n(timeline.log.parsed)} lines parsed (${n(timeline.log.calls.length)} write calls) from ${args.skyforgeLog}`);
      const pct = c.events ? Math.round((c.matched / c.events) * 100) : 0;
      say(`Attribution: ${n(c.matched)} matched, ${n(c.ambiguous + c.timeOnly)} ambiguous (${n(c.timeOnly)} on table and time only), ${n(c.unmatched)} unmatched (${pct}% matched; window ${args.logWindowSec} s).`);
    }
    say(`History: ${path.relative(project, historyPath(root, scope.scope))}`);
    const ignored = ensureGitignored(project);
    if (ignored === 'added') say('Added .livemap/ to .gitignore');
    if (args.mirrorOnly) return;
    const serveArgs: Args = { dir: root, port: args.port, open: args.open, pullSec: null, history: args.history, summaries: false };
    await core.serve(root, serveArgs, {
      analyzers: [serviceNowAnalyzer(root)],
      recordOf: recordResolver(root),
      git: false,
      title: `${scope.scope} on ${manifest.instance || instance}`,
    });
  } catch (e) {
    if (e instanceof NexusOfflineError) fail(`${e.message}\nIs SkyForge running? Start it, or pass --nexus with its MCP URL.`);
    if (e instanceof ScopeNotFoundError || e instanceof NexusToolError) fail(e.message);
    throw e;
  } finally {
    // M1 reads once; live polling (M3) keeps its own connection.
    await client.close();
  }
}
