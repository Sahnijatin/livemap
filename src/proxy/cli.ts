/**
 * `livemap mcp-proxy --upstream URL [--header NAME=VALUE]... | --upstream-cmd "COMMAND"`. A desktop MCP
 * client launches it in place of the upstream server. stdout carries MCP messages only; notes go to stderr.
 */
import { HookPoster } from './poster.js';
import { ChildEndpoint, HttpEndpoint, INSTANCE_HEADER, LineEndpoint, runProxy, splitCommand, type Endpoint } from './proxy.js';
import { argNames } from './capture.js';

export const PROXY_USAGE = 'Usage: livemap mcp-proxy --upstream URL [--header NAME=VALUE]... | --upstream-cmd "COMMAND"';

export interface ProxyArgs { upstream?: string; headers: Record<string, string>; upstreamCmd?: string; debug: boolean }

export function parseProxyArgs(argv: string[], onError: (m: string) => never): ProxyArgs {
  const out: ProxyArgs = { headers: {}, debug: !!process.env.LIVEMAP_PROXY_DEBUG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const take = (): string => {
      const v = inline ?? argv[++i];
      return v === undefined || (inline === undefined && v.startsWith('--')) ? onError(`${flag} needs a value`) : v;
    };
    if (flag === '--upstream') {
      const v = take();
      let u: URL;
      try { u = new URL(v); } catch { onError(`invalid --upstream URL: ${v}`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') onError('--upstream must be an http or https URL');
      out.upstream = v;
    } else if (flag === '--header') {
      const v = take();
      const at = v.indexOf('=');
      if (at <= 0) onError('--header needs NAME=VALUE');
      out.headers[v.slice(0, at).trim()] = v.slice(at + 1);
    } else if (flag === '--upstream-cmd') out.upstreamCmd = take();
    else if (a === '--debug') out.debug = true;
    else if (a === '-h' || a === '--help') { process.stderr.write(`${PROXY_USAGE}\n`); process.exit(0); }
    else onError(`unknown option: ${a}`);
  }
  if (!out.upstream === !out.upstreamCmd) onError('give exactly one of --upstream or --upstream-cmd');
  if (out.upstreamCmd && !splitCommand(out.upstreamCmd).length) onError('--upstream-cmd is empty');
  if (out.upstreamCmd && Object.keys(out.headers).length) onError('--header only applies to --upstream');
  return out;
}

const fail = (m: string): never => {
  process.stderr.write(`livemap mcp-proxy: ${m}\n${PROXY_USAGE}\n`);
  process.exit(1);
};

/** Header value of `name`, matched case-insensitively. */
const headerValue = (headers: Record<string, string>, name: string): string | undefined =>
  Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];

export async function runMcpProxy(argv: string[]): Promise<void> {
  const args = parseProxyArgs(argv, fail);
  const debug = args.debug ? (line: string) => { try { process.stderr.write(`livemap mcp-proxy: ${line}\n`); } catch { /* closed */ } } : undefined;
  let upstream: Endpoint;
  let upstreamName: string;
  if (args.upstream) {
    const url = new URL(args.upstream);
    upstream = new HttpEndpoint(url, args.headers);
    upstreamName = `${url.origin}${url.pathname}`;
    debug?.(`upstream ${upstreamName}, header names: ${argNames(args.headers).join(', ') || 'none'}`);
  } else {
    const [cmd, ...rest] = splitCommand(args.upstreamCmd as string);
    upstream = new ChildEndpoint(cmd, rest);
    upstreamName = cmd;
    debug?.(`upstream command ${cmd}`);
  }
  const poster = new HookPoster();
  const client = new LineEndpoint(process.stdin, process.stdout, (why) => debug?.(`skipped a client line: ${why}`));
  const instance = headerValue(args.headers, INSTANCE_HEADER);
  await runProxy({ client, upstream, capture: (e) => poster.send(e), upstreamName, ...(instance ? { instance } : {}), ...(debug ? { debug } : {}) });
  // Give queued events a moment to reach LiveMap, never long enough to hold up the client's shutdown.
  await Promise.race([poster.flushed(), new Promise((r) => setTimeout(r, 300).unref())]);
  const code = upstream instanceof ChildEndpoint ? upstream.exitCode ?? 0 : 0;
  process.exit(code);
}
