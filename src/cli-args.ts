import { DEFAULT_PORT } from './server/server.js';
import type { Analyzer } from './engine/domain/index.js';
import type { RecordKey } from './agents/attribution.js';

/** How a source other than a plain folder (the ServiceNow mirror) runs the server on its files. */
export interface ServeOptions {
  /** Analyzers added to the built-in ones. */
  analyzers?: Analyzer[];
  /** Maps a changed path to the record it mirrors, for attribution. */
  recordOf?: (path: string) => RecordKey | undefined;
  /** False: no git polling (the folder is not a repo). */
  git?: boolean;
  /** What "LiveMap is watching ..." names instead of the folder. */
  title?: string;
}
/** What core hands a source's command: the server loop and root resolution. */
export interface CoreHooks {
  serve(root: string, args: Args, opts?: ServeOptions): Promise<void>;
  resolveRoot(dir: string): string;
}

export const USAGE = 'Usage: livemap [dir=.] [--port N] [--no-open] [--pull[=SEC]] [--no-history] [--summaries]\n       livemap init [dir=.] [--agents claude,codex,cursor] [--remove]\n       livemap export [dir=.] [--session ID] [--no-code] [--out FILE]\n       livemap sn [dir=.] --scope NAMESPACE|SYS_ID [--instance NAME] [--nexus URL] [--port N] [--no-open] [--no-history] [--mirror-only]';
const DEFAULT_PULL_SEC = 15;

export interface Args { dir: string; port: number; open: boolean; pullSec: number | null; history: boolean; summaries: boolean }

export function fail(message: string): never {
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

export function parseArgs(argv: string[]): Args {
  const args: Args = { dir: '.', port: DEFAULT_PORT, open: true, pullSec: null, history: true, summaries: false };
  let sawDir = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') args.open = false;
    else if (a === '--no-history') args.history = false;
    else if (a === '--summaries') args.summaries = true;
    else if (a === '--pull') {
      args.pullSec = DEFAULT_PULL_SEC;
      if (/^\d+$/.test(argv[i + 1] ?? '')) args.pullSec = parsePull(argv[++i]);
    }
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
