import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectModel } from './engine/project.js';
import { Watcher } from './engine/watcher.js';
import { startServer, DEFAULT_PORT } from './server/server.js';
import { openBrowser } from './server/open.js';

const USAGE = 'Usage: livemap [dir=.] [--port N] [--no-open]';

interface Args { dir: string; port: number; open: boolean }

function fail(message: string): never {
  process.stderr.write(`livemap: ${message}\n${USAGE}\n`);
  process.exit(1);
}

function parsePort(v: string | undefined): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) > 65535) fail(`invalid port: ${v ?? '(missing)'}`);
  return Number(v);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: '.', port: DEFAULT_PORT, open: true };
  let sawDir = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') args.open = false;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args.dir);
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

  const model = new ProjectModel(root);
  const watcher = new Watcher(model);
  watcher.on('error', (e: Error) => process.stderr.write(`livemap: watcher error: ${e.message}\n`));

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ model, watcher, port: args.port, uiDir });
  } catch (e) {
    fail(`could not start server: ${(e as Error).message}`);
  }

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) process.exit(0); // second signal: stop waiting
    stopping = true;
    setTimeout(() => process.exit(0), 3000).unref(); // failsafe if cleanup hangs
    try {
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
