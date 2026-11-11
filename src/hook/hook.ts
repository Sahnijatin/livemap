/**
 * `node hook.mjs <agent> <event>`: forwards an agent hook payload to the running LiveMap for this project.
 * Bundled standalone (node: built-ins only). It exits 2 only to block a blockable event the server asked
 * to block, or to hand a stopping agent a message from the user; every other path exits 0.
 */
import http from 'node:http';
import type { AgentKind } from '../shared/types.js';
import { findRuntime } from '../agents/runtime.js';
import { isBlockable, isStop } from '../shared/blockable.js';

const MAX_STDIN = 8 * 1024 * 1024;
const STDIN_WAIT_MS = 1000;
const REQUEST_BUDGET_MS = 1500;
/**
 * One deadline for the whole run. With the exit grace and node startup (100-300 ms, far more on a
 * loaded machine) the worst case stays under 2.5 s with real margin.
 */
const TOTAL_BUDGET_MS = 1600;
const EXIT_GRACE_MS = 50;
const started = Date.now();

// A closed pipe must never change the exit code.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const AGENTS = new Set(['claude-code', 'codex', 'cursor']);

/** Up to 8 MB of stdin (the rest is discarded); stops at end, or after 1 s, or at once for a TTY. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve('');
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.pause();
      stdin.unref?.();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer) => {
      if (size >= MAX_STDIN) return;
      const take = chunk.subarray(0, MAX_STDIN - size);
      chunks.push(take);
      size += take.length;
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    stdin.on('data', onData);
    stdin.once('end', finish);
    stdin.once('error', finish);
  });
}

function startDir(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.cwd === 'string' && p.cwd) return p.cwd;
    const roots = p.workspace_roots;
    if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) return roots[0];
  }
  return process.cwd();
}

interface Answer { block: string | null; followup: string | null }
const NOTHING: Answer = { block: null, followup: null };

/** The server's block reason and follow-up message; neither on any failure, timeout or plain answer. */
function post(port: number, token: string, body: string, budgetMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(v);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-livemap-token': token },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(NOTHING);
        try {
          const o = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { block?: unknown; followup?: unknown };
          const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
          finish({ block: text(o.block), followup: text(o.followup) });
        } catch {
          finish(NOTHING);
        }
      });
      res.on('error', () => finish(NOTHING));
    });
    const timer = setTimeout(() => finish(NOTHING), budgetMs);
    req.on('error', () => finish(NOTHING));
    req.end(body);
  });
}

async function main(): Promise<number> {
  const [agent, event] = process.argv.slice(2);
  const raw = await readStdin();
  if (!agent || !event || !AGENTS.has(agent)) return 0;
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return 0; }
  const rt = findRuntime(startDir(payload));
  if (!rt) return 0;
  const budget = Math.min(REQUEST_BUDGET_MS, TOTAL_BUDGET_MS - (Date.now() - started));
  if (budget <= 0) return 0;
  const answer = await post(rt.port, rt.token, JSON.stringify({ agent, event, payload, followup: true }), budget);
  // A message the user sent from LiveMap, for an agent that just finished its turn: it carries on with it.
  if (answer.followup && isStop(agent as AgentKind, event)) {
    // Cursor reads the follow-up from stdout; Claude Code and Codex continue on exit 2 with the text on stderr.
    if (agent === 'cursor') { process.stdout.write(JSON.stringify({ followup_message: answer.followup })); return 0; }
    process.stderr.write(`${answer.followup}\n`);
    return 2;
  }
  const reason = answer.block;
  if (!reason || !isBlockable(agent as AgentKind, event)) return 0;
  process.stderr.write(`${reason}\n`);
  if (agent === 'cursor') process.stdout.write(JSON.stringify({ permission: 'deny', agent_message: reason, user_message: 'Blocked by LiveMap' }));
  return 2;
}

const exit = (code: number) => {
  process.exitCode = code;
  // Let stdout and stderr drain; force the exit only if some handle (an open stdin) would keep us alive.
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
};
main().then(exit, () => exit(0));
