/**
 * `livemap sn`: mirrors a ServiceNow scope through SkyForge's nexus MCP (read-only), then runs LiveMap on
 * the mirror. Registered from core's CLI until the plugin loader (#53) exists; it only uses `CoreHooks`.
 */
import path from 'node:path';
import type { Args, CoreHooks } from '../../src/cli-args.js';
import { DEFAULT_PORT } from '../../src/server/server.js';
import { serviceNowAnalyzer } from './analyzer.js';
import { instanceInfo, pullScope, resolveScope, ScopeNotFoundError } from './backfill.js';
import { changeFacts, readChangeRows, updateNameIndex, updateSetNames } from './changes.js';
import { layoutMirror, type ChangeFacts } from './mirror.js';
import { DEFAULT_NEXUS_URL, NexusClient, NexusOfflineError, NexusToolError } from './nexus.js';
import { recordResolver } from './records.js';
import { DEFAULT_LOG_WINDOW_MS, DEFAULT_SKYFORGE_LOG } from './skyforge-log.js';
import { DEFAULT_POLL_MS, initialState, ScopePoller } from './poller.js';
import { buildTimeline, LiveTimeline } from './timeline.js';
import { importScopeHistory } from './history-run.js';
import { ensureGitignored, historyPath, readPollState, snRoot, writeHistory, writeMirror } from './writer.js';
import { buildDomainIndex, newDataRefCache } from '../../src/engine/domain/build-index.js';
import type { ServeHandles } from '../../src/cli-args.js';
import type { FileModel } from '../../src/shared/types.js';
import type { SnRecord } from './nexus.js';

export const SN_USAGE = 'Usage: livemap sn [dir=.] --scope NAMESPACE|SYS_ID [--instance NAME] [--nexus URL] [--skyforge-log FILE|none] [--log-window SECONDS] [--poll SECONDS|off] [--port N] [--no-open] [--no-history] [--mirror-only]';

export interface SnArgs {
  dir: string; scope: string; instance?: string; nexus: string;
  port: number; open: boolean; history: boolean; mirrorOnly: boolean;
  /** SkyForge's MCP log for history attribution; null skips it. */
  skyforgeLog: string | null;
  logWindowSec: number;
  /** Seconds between live polls of the instance; null turns polling off. */
  pollSec: number | null;
}

function fail(message: string): never {
  process.stderr.write(`livemap sn: ${message}\n${SN_USAGE}\n`);
  process.exit(1);
}

export function parseSnArgs(argv: string[], onError: (m: string) => never = fail): SnArgs {
  const args: Partial<SnArgs> & { dir: string } = {
    dir: '.', nexus: DEFAULT_NEXUS_URL, port: DEFAULT_PORT, open: true, history: true, mirrorOnly: false,
    skyforgeLog: DEFAULT_SKYFORGE_LOG, logWindowSec: DEFAULT_LOG_WINDOW_MS / 1000, pollSec: DEFAULT_POLL_MS / 1000,
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
    } else if (flag === '--poll') {
      const v = take();
      if (v.toLowerCase() === 'off') args.pollSec = null;
      else if (!/^\d+$/.test(v) || Number(v) < 2 || Number(v) > 60) onError(`invalid --poll (2 to 60 seconds, or off): ${v}`);
      else args.pollSec = Number(v);
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
    // Each record's last change: the update set from its latest update_xml row, the user and time from the
    // record. After a good pull, any failure here (a refusal, a timeout, nexus going away) is only a warning.
    let changeRows: SnRecord[] = [];
    const setNames = new Map<string, string>();
    let facts = new Map<string, ChangeFacts>();
    const invById = new Map(pulled.inventory.map(r => [r.sys_id, r]));
    try {
      changeRows = await readChangeRows(client, scope);
      await updateSetNames(client, changeRows, setNames);
      facts = changeFacts(changeRows, updateNameIndex(pulled.full), setNames, undefined, id => {
        const r = pulled.full.get(id) ?? invById.get(id);
        return r ? { on: r.sys_updated_on, by: r.sys_updated_by } : undefined;
      });
    } catch (e) {
      process.stderr.write(`livemap sn: warning: update sets and change users are not shown (${e instanceof Error ? e.message : String(e)})\n`);
    }
    const { files, manifest } = layoutMirror({ instance: info?.name ?? args.instance ?? '', scope, ...pulled, rootAbs: root, facts });
    const res = writeMirror(root, files, manifest);
    const classes = Object.keys(manifest.byClass).length;
    say(`Pulled ${n(pulled.inventory.length)} records in ${n(classes)} classes in ${secs(Date.now() - t0)} (${n(pulled.queries)} queries).`);
    say(`Mirror: ${path.relative(project, path.join(root, scope.scope)) || '.'} (${n(res.written)} files written, ${n(res.unchanged)} unchanged, ${n(res.removed)} removed)`);
    const ignored = ensureGitignored(project);
    if (ignored === 'added') say('Added .livemap/ to .gitignore');
    for (const f of pulled.failedClasses) process.stderr.write(`livemap sn: warning: ${f.class}: kept names and dates only (${f.error})\n`);
    const t1 = Date.now();
    let liveHistory: LiveTimeline | undefined;
    if (!args.history) say('History: skipped (--no-history).');
    else {
      // History is extra: any failure is a warning, and the mirror and UI go on without it.
      try {
        const timeline = await buildTimeline(client, scope, pulled.inventory, manifest, {
          logFile: args.skyforgeLog, windowMs: args.logWindowSec * 1000, full: pulled.full, ...(changeRows.length ? { history: { updateXml: changeRows } } : {}),
        });
        writeHistory(root, scope.scope, timeline.doc);
        liveHistory = new LiveTimeline(timeline.doc, { root, logFile: args.skyforgeLog, windowMs: args.logWindowSec * 1000 });
        const h = timeline.history;
        const recaptures = h.captured - h.commits ? `, plus ${n(h.captured - h.commits)} recaptures` : '';
        const commits = h.commits || h.commitDeletes ? `, ${n(h.commits + h.commitDeletes)} written by an update set commit` : '';
        const creations = h.recordEvents ? `, ${n(h.recordEvents)} creations from the records' own stamps` : '';
        say(`Versions imported: ${n(h.versionEvents + h.xmlEvents)} (${n(h.versionEvents)} from sys_update_version, ${n(h.xmlEvents)} from sys_update_xml${recaptures}${commits}${creations}) for ${n(h.fromVersions + h.fromUpdateXml)} records in ${secs(Date.now() - t1)} (${n(h.queries)} queries).`);
        for (const w of h.warnings) process.stderr.write(`livemap sn: warning: history: ${w}\n`);
        const c = timeline.doc.counts;
        const log = timeline.doc.log;
        if (!args.skyforgeLog || !log) say('SkyForge log: skipped (--skyforge-log none).');
        else if (!h.events.length) say('SkyForge log: not read (no history to match).');
        else if (!timeline.log) say(`SkyForge log: not found at ${log.file}; attribution skipped.`);
        else {
          const elsewhere = log.otherInstance || log.unknownInstance ? `; ${n(log.otherInstance)} on other instances, ${n(log.unknownInstance)} on an unknown instance` : '';
          say(`SkyForge log: ${n(timeline.log.parsed)} lines parsed (${n(log.calls)} write calls${elsewhere}) from ${log.file}`);
          const unknown = Object.entries(timeline.log.unknownTools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
          if (unknown.length) say(`SkyForge log: tools LiveMap does not know, read as reads: ${unknown.map(([t, k]) => `${t} (${n(k)})`).join(', ')}`);
          const others = log.agentUsers.filter(u => u !== log.agentUser);
          say(log.agentUser
            ? `SkyForge user: ${log.agentUser} (from the ${log.agentUserFrom === 'log' ? 'log' : 'nexus session'})${others.length ? `; the log also names ${others.join(', ')}` : ''}. Saves by other users match only calls that name them.`
            : 'SkyForge user: unknown. Table and time matches are marked "author not checked".');
          const pct = c.events ? Math.round((c.matched / c.events) * 100) : 0;
          const loose = c.timeOnly + c.authorUnchecked;
          say(`Attribution: ${n(c.matched)} matched, ${n(c.ambiguous + loose + c.hostUnknown)} ambiguous (${n(loose)} on table and time only, ${n(c.authorUnchecked)} of them with the author not checked, ${n(c.hostUnknown)} on an unknown instance), ${n(c.unmatched)} unmatched (${pct}% matched; window ${args.logWindowSec} s).`);
        }
        say(`History: ${path.relative(project, historyPath(root, scope.scope))}`);
      } catch (e) {
        process.stderr.write(`livemap sn: warning: history: skipped (${e instanceof Error ? e.message : String(e)})\n`);
      }
    }
    if (args.mirrorOnly) return;
    const serveArgs: Args = { dir: root, port: args.port, open: args.open, pullSec: null, history: args.history, summaries: false };
    let handles: ServeHandles | undefined;
    const scopeName: string = scope.scope;
    await core.serve(root, serveArgs, {
      analyzers: [serviceNowAnalyzer(root)],
      recordOf: recordResolver(root),
      git: false,
      title: `${scope.scope} on ${manifest.instance || instance}`,
      onReady: h => { handles = h; },
      beforeRun: async ({ model, history, say: line }) => {
        const domainOf = (files: FileModel[]) => buildDomainIndex(files, p => model.content(p), newDataRefCache());
        const t = Date.now();
        const r = await importScopeHistory(history, { root, name: scopeName, scope: scopeName, files: model.all(), domainOf });
        if (r.status === 'imported') line(`Timeline: ${n(r.imported)} history events imported as a back-dated run in ${secs(Date.now() - t)}${r.skipped ? ` (${n(r.skipped)} without a mirrored file left out)` : ''}.`);
        else if (r.status === 'already') line('Timeline: history already imported.');
        else if (r.status === 'partial') line('Timeline: the history is partial, so it is not in the timeline yet. A later start with the full history adds it.');
      },
    });
    if (args.pollSec === null) { say('Live polling: off (--poll off).'); return; }
    // No handles: LiveMap was stopped while it indexed, so there is nothing to poll for.
    if (!handles) return;
    // Its own connection, which fails fast: a poll that cannot reach nexus marks the instance offline and
    // backs off. It is named "livemap" like every LiveMap session, so its calls are never attributed.
    let wasOffline = false;
    const live = new NexusClient({ url: args.nexus, instance: args.instance, attempts: 1, timeoutMs: 30_000 });
    const poller = new ScopePoller(live, {
      instance: manifest.instance || instance, scope, inventory: pulled.inventory, full: pulled.full, facts, setNames, pulledAt: manifest.pulledAt,
    }, readPollState(root, scope.scope) ?? initialState(scope.scope, changeRows, pulled.inventory, undefined, pulled.full), {
      root,
      intervalMs: args.pollSec * 1000,
      onStatus: st => {
        handles?.setSource(st);
        if (st.state === 'offline') process.stderr.write(`livemap sn: warning: instance offline (${st.detail ?? 'nexus did not answer'}); showing the last mirror\n`);
        else if (wasOffline) say('Instance back online; catching up.');
        wasOffline = st.state === 'offline';
      },
      onSkew: ms => handles?.setSkewMs(ms),
      // New saves join the history file, matched to SkyForge's log like the imported ones.
      ...(liveHistory ? { onSaves: (rows, ctx, m) => liveHistory!.addSaves(rows, ctx.full, m, ctx.inventory) } : {}),
      warn: m => process.stderr.write(`livemap sn: warning: ${m}\n`),
      onFirstPoll: lines => { for (const l of lines) say(`First poll: ${l}`); },
    });
    handles.onRecordGap(g => poller.learnGap(g));
    // No poll may write after shutdown has begun.
    handles.onShutdown(() => poller.stop());
    poller.start();
    say(`Live polling every ${args.pollSec} s (read-only).`);
  } catch (e) {
    if (e instanceof NexusOfflineError) fail(`${e.message}\nIs SkyForge running? Start it, or pass --nexus with its MCP URL.`);
    if (e instanceof ScopeNotFoundError || e instanceof NexusToolError) fail(e.message);
    throw e;
  } finally {
    // M1 reads once; live polling (M3) keeps its own connection.
    await client.close();
  }
}
