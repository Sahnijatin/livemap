import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin, pluginTarget } from '../../plugins/servicenow/skyforge-plugin/install.js';
import { backfillSessions, parseBackfillArgs, parseSince, sessionEvents, sessionsOf } from '../../plugins/servicenow/skyforge-plugin/backfill-sessions.js';
import type { CaptureEvent, TextEvent } from '../../src/proxy/capture.js';
import { captureEvents, captureKey, ingestCapture } from '../../src/agents/capture.js';
import { AgentHub } from '../../src/agents/hub.js';
import { buildCapture, buildText, SessionContext } from '../../src/proxy/capture.js';
import { buildOnce } from '../build.js';
import { withHome } from '../helpers/platform.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repo, 'dist', 'cli.js');
const NEXUS = 'nexus_ses_ebf63bf49ffeGGE3hEhWQuinBE_';
const SYS = 'a'.repeat(32);
const temps: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('livemap sn install-plugin', () => {
  const setup = (withSkyforge = true) => {
    const home = tmp('lm-sfhome-');
    if (withSkyforge) fs.mkdirSync(path.join(home, '.skyforge'));
    const source = path.join(tmp('lm-sfsrc-'), 'livemap-skyforge.js');
    fs.writeFileSync(source, 'export const LivemapSkyforge = async () => ({});\n');
    const lines: string[] = [];
    const asked: string[] = [];
    const run = (argv: string[], answer: boolean) => installPlugin(argv, { home, source, say: (l) => lines.push(l), ask: async (q) => { asked.push(q); return answer; } });
    return { home, source, lines, asked, run, target: pluginTarget(home) };
  };

  it('shows the path, asks, copies on yes, and says to restart SkyForge', async () => {
    const s = setup();
    expect(await s.run([], true)).toBe(0);
    expect(s.target).toBe(path.join(s.home, '.skyforge', 'plugin', 'livemap-skyforge.js'));
    expect(s.lines[0]).toContain(s.target);
    expect(s.asked).toEqual(['Copy it? [y/N] ']);
    expect(fs.readFileSync(s.target, 'utf8')).toBe(fs.readFileSync(s.source, 'utf8'));
    expect(s.lines.at(-1)).toBe('Copied. Restart SkyForge to load it.');
  });

  it('copies nothing without a yes', async () => {
    const s = setup();
    expect(await s.run([], false)).toBe(0);
    expect(fs.existsSync(s.target)).toBe(false);
    expect(s.lines.at(-1)).toBe('Nothing copied.');
  });

  it('says so when already up to date, without asking', async () => {
    const s = setup();
    await s.run([], true);
    s.asked.length = 0;
    expect(await s.run([], true)).toBe(0);
    expect(s.asked).toEqual([]);
    expect(s.lines.at(-1)).toContain('already installed and up to date');
  });

  it('refuses when SkyForge was never run (no ~/.skyforge)', async () => {
    const s = setup(false);
    expect(await s.run([], true)).toBe(1);
    expect(fs.existsSync(path.join(s.home, '.skyforge'))).toBe(false);
  });

  it('--uninstall removes only that file, after a yes', async () => {
    const s = setup();
    await s.run([], true);
    const other = path.join(path.dirname(s.target), 'someone-else.js');
    fs.writeFileSync(other, '//');
    expect(await s.run(['--uninstall'], false)).toBe(0);
    expect(fs.existsSync(s.target)).toBe(true);
    expect(await s.run(['--uninstall'], true)).toBe(0);
    expect(fs.existsSync(s.target)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(s.lines.at(-1)).toContain('Restart SkyForge');
    expect(await s.run(['--uninstall'], true)).toBe(0);
    expect(s.lines.at(-1)).toContain('not installed');
  });

  it('rejects unknown options', async () => {
    const s = setup();
    expect(await s.run(['--yes'], true)).toBe(1);
    expect(fs.existsSync(s.target)).toBe(false);
  });

  describe('built CLI', () => {
    beforeAll(buildOnce, 180_000);
    it('copies dist/livemap-skyforge.js after a typed yes, and removes it again', () => {
      const home = tmp('lm-sfcli-');
      fs.mkdirSync(path.join(home, '.skyforge'));
      const env = withHome({ ...process.env }, home);
      const a = spawnSync(process.execPath, [cli, 'sn', 'install-plugin'], { env, input: 'y\n', encoding: 'utf8' });
      expect(a.status, a.stderr).toBe(0);
      const target = path.join(home, '.skyforge', 'plugin', 'livemap-skyforge.js');
      expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(path.join(repo, 'dist', 'livemap-skyforge.js'), 'utf8'));
      const no = spawnSync(process.execPath, [cli, 'sn', 'install-plugin', '--uninstall'], { env, input: 'n\n', encoding: 'utf8' });
      expect(no.status).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
      const b = spawnSync(process.execPath, [cli, 'sn', 'install-plugin', '--uninstall'], { env, input: 'yes\n', encoding: 'utf8' });
      expect(b.status, b.stderr).toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    });
  });
});

/** Messages as `/session/{id}/message` returns them: `[{info, parts}]`. */
function messages(t0: number) {
  return [
    { info: { id: 'm1', sessionID: 'ses_a', role: 'user', time: { created: t0 } }, parts: [{ id: 'p1', type: 'text', text: 'Build the card offer widget' }] },
    {
      info: { id: 'm2', sessionID: 'ses_a', role: 'assistant', time: { created: t0 + 1000, completed: t0 + 9000 } },
      parts: [
        { id: 'p2', type: 'text', text: 'Making the update set first.', time: { start: t0 + 1000, end: t0 + 1500 } },
        { id: 'p3', type: 'tool', callID: 'call_1', tool: `${NEXUS}tool_execute`, state: { status: 'completed', input: { tool: 'sn_update_set_manage', args: { action: 'create', name: 'CC offers' } }, output: JSON.stringify({ success: true, tool: 'sn_update_set_manage', result: { success: true, data: { sys_id: '1'.repeat(32) } } }), title: '', metadata: {}, time: { start: t0 + 2000, end: t0 + 2600 } } },
        { id: 'p4', type: 'tool', callID: 'call_2', tool: `${NEXUS}tool_execute`, state: { status: 'completed', input: { tool: 'sn_record_manage', args: { action: 'create', table: 'sp_widget', data: { name: 'Offer card' } } }, output: JSON.stringify({ success: true, tool: 'sn_record_manage', result: { success: true, data: { sys_id: SYS } } }), title: '', metadata: {}, time: { start: t0 + 3000, end: t0 + 3400 } } },
        { id: 'p5', type: 'tool', callID: 'call_3', tool: `${NEXUS}sn_execute_background_script`, state: { status: 'error', input: { script: 'x', password: 'p' }, error: 'Script failed: token=abc', time: { start: t0 + 4000, end: t0 + 4100 } } },
        { id: 'p6', type: 'tool', callID: 'call_4', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a', title: '', metadata: {}, time: { start: t0 + 5000, end: t0 + 5100 } } },
        { id: 'p7', type: 'tool', callID: 'call_5', tool: `${NEXUS}sn_query_table`, state: { status: 'running', input: { table: 'x' }, time: { start: t0 + 6000 } } },
        { id: 'p8', type: 'text', text: 'still typing', time: { start: t0 + 7000 } },
      ],
    },
  ];
}

describe('livemap sn backfill-sessions', () => {
  const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

  it('reads arguments', () => {
    const err = (m: string): never => { throw new Error(m); };
    expect(parseBackfillArgs(['--since', '2026-10-01'], err)).toMatchObject({ url: 'http://127.0.0.1:4096', dryRun: false, since: parseSince('2026-10-01') });
    expect(parseBackfillArgs(['--since=2026-10-01T09:00Z', '--url', 'http://127.0.0.1:5000/', '--dry-run'], err)).toMatchObject({ url: 'http://127.0.0.1:5000', dryRun: true, since: Date.UTC(2026, 9, 1, 9) });
    expect(() => parseBackfillArgs([], err)).toThrow(/--since is required/);
    expect(() => parseBackfillArgs(['--since', 'soon'], err)).toThrow(/invalid --since/);
  });

  it('lists TUI and Hub sessions, leaving out MCP sessions', () => {
    expect(sessionsOf({ sessions: [{ id: 'ses_a', instance: 'devtest', source: 'tui' }, { id: 'ses_m', instance: 'devtest', source: 'mcp' }, { nope: 1 }] }))
      .toEqual([{ id: 'ses_a', instance: 'devtest', source: 'tui' }]);
    expect(sessionsOf([{ id: 'ses_b' }])).toEqual([{ id: 'ses_b' }]);
  });

  it('turns past messages into events with their real times', () => {
    const evs = sessionEvents('ses_a', messages(T0), T0, 'devtest');
    const kinds = evs.map((e) => ('kind' in e ? e.kind : (e as CaptureEvent).innerTool ?? (e as CaptureEvent).tool));
    expect(kinds).toEqual(['prompt', 'message', 'sn_update_set_manage', 'sn_record_manage', 'sn_execute_background_script']);
    const create = evs[3] as CaptureEvent;
    expect(create).toMatchObject({ start: T0 + 3000, end: T0 + 3400, instance: 'devtest', resultSysIds: [SYS], updateSet: { sysId: '1'.repeat(32), name: 'CC offers' } });
    expect(create.targets).toContainEqual({ kind: 'record', instance: 'devtest', table: 'sp_widget', sysId: SYS, name: 'Offer card' });
    const failed = evs[4] as CaptureEvent;
    expect(failed).toMatchObject({ ok: false, error: 'Script failed: token=[redacted]' });
    expect(JSON.stringify(failed)).not.toContain('"p"');
    expect((evs[0] as TextEvent)).toMatchObject({ kind: 'prompt', at: T0, text: 'Build the card offer widget' });
    // Hub conversion keeps the real times.
    expect(captureEvents(create as unknown as Record<string, unknown>, T0 + 60_000).map((e) => e.at)).toEqual([T0 + 3000, T0 + 3400]);
  });

  it('skips what came before --since', () => {
    expect(sessionEvents('ses_a', messages(T0), T0 + 2500, 'devtest').map((e) => ('kind' in e ? e.kind : (e as CaptureEvent).innerTool ?? (e as CaptureEvent).tool))).toEqual(['sn_record_manage', 'sn_execute_background_script']);
  });

  it('reads the mock SkyForge API with GETs only, and falls back to /session without analytics', async () => {
    const seen: string[] = [];
    const run = async (analytics: boolean) => {
      const s = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        const json = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
        if (req.url === '/api/analytics/sessions') return analytics ? json({ sessions: [{ id: 'ses_a', instance: 'devtest', source: 'tui' }, { id: 'ses_m', source: 'mcp' }] }) : res.writeHead(404).end();
        if (req.url === '/session') return json([{ id: 'ses_a', title: 'x', time: { created: T0, updated: T0 } }]);
        if (req.url === '/session/ses_a/message') return json(messages(T0));
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      try {
        const sent: unknown[] = [];
        const r = await backfillSessions({ since: T0, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, dryRun: false }, (e) => sent.push(e));
        return { r, sent };
      } finally {
        await new Promise<void>((r) => s.close(() => r()));
      }
    };
    const a = await run(true);
    expect(a.r).toEqual({ sessions: 1, found: 5, sent: 5, calls: 3, prompts: 1, messages: 1 });
    expect((a.sent[2] as CaptureEvent).instance).toBe('devtest');
    const b = await run(false);
    expect(b.r.calls).toBe(3);
    expect((b.sent[2] as CaptureEvent).instance).toBeUndefined();
    expect(seen.every((x) => x.startsWith('GET '))).toBe(true);
    expect(seen).not.toContain('GET /session/ses_m/message');
  });
});

describe('no duplicates', () => {
  const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);
  const hubs: AgentHub[] = [];
  afterEach(() => { for (const h of hubs.splice(0)) h.stop(); });
  const newHub = () => { const h = new AgentHub('/p/.livemap/sn'); hubs.push(h); return h; };
  const asObj = (e: unknown) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

  it('a live capture plus its backfilled copy gives one pair, and a second backfill adds nothing', () => {
    const hub = newHub();
    const msgs = messages(T0);
    const toolPart = (msgs[1].parts as { callID?: string; tool?: string; state?: { input: unknown; output: string; time: { start: number; end: number } } }[])[2];
    // What the plugin sent live for that call, and for the prompt and the assistant text.
    const live = buildCapture({ source: 'skyforge-plugin', client: { name: 'skyforge' }, sessionId: 'ses_a', callId: toolPart.callID as string, name: toolPart.tool as string, args: toolPart.state!.input, result: { content: [{ type: 'text', text: toolPart.state!.output }] }, start: T0 + 3000, end: T0 + 3400 }, new SessionContext());
    expect(ingestCapture(hub, asObj(live))).toBe(true);
    expect(ingestCapture(hub, asObj(buildText('prompt', 'ses_a', T0, 'Build the card offer widget', 'm1')))).toBe(true);
    expect(ingestCapture(hub, asObj(buildText('message', 'ses_a', T0 + 1500, 'Making the update set first.', 'p2')))).toBe(true);
    for (let run = 0; run < 2; run++) for (const e of sessionEvents('ses_a', msgs, T0, 'devtest')) ingestCapture(hub, asObj(e));
    const evs = hub.events();
    const count = (f: (e: (typeof evs)[number]) => boolean) => evs.filter(f).length;
    expect(count((e) => e.tool?.id === 'call_2')).toBe(2);
    expect(count((e) => e.type === 'tool_start')).toBe(3);
    expect(count((e) => e.type === 'prompt')).toBe(1);
    expect(count((e) => e.type === 'message')).toBe(1);
  });

  it('keys by source, session and call or text id; idle and id-less text are never treated as repeats', () => {
    expect(captureKey({ source: 'skyforge-plugin', sessionId: 's', callId: 'c' })).not.toBe(captureKey({ source: 'mcp-proxy', sessionId: 's', callId: 'c' }));
    expect(captureKey({ source: 'skyforge-plugin', sessionId: 's', kind: 'idle' })).toBeUndefined();
    expect(captureKey({ source: 'skyforge-plugin', sessionId: 's', kind: 'message', text: 'x' })).toBeUndefined();
    const hub = newHub();
    const idle = { source: 'skyforge-plugin', sessionId: 's', kind: 'idle', at: T0 };
    expect(ingestCapture(hub, idle)).toBe(true);
    expect(ingestCapture(hub, { ...idle, at: T0 + 60_000 })).toBe(true);
  });

  it('a prompt with no message id gets the same id live and backfilled (session and time)', () => {
    const msgs = [{ info: { sessionID: 'ses_b', role: 'user', time: { created: T0 } }, parts: [{ type: 'text', text: 'hi' }] }];
    expect((sessionEvents('ses_b', msgs, 0)[0] as TextEvent).textId).toBe(`ses_b:${T0}`);
  });

  it('--limit keeps the newest events and says how many were found', async () => {
    const sent: unknown[] = [];
    const get = async (url: string) => (url.endsWith('/api/analytics/sessions') ? [{ id: 'ses_a', instance: 'devtest' }] : messages(T0));
    const r = await backfillSessions({ since: T0, url: 'http://x', dryRun: false, limit: 2 }, (e) => sent.push(e), get);
    expect(r).toMatchObject({ found: 5, sent: 2, calls: 2, prompts: 0, messages: 0 });
    expect(sent.map((e) => (e as CaptureEvent).start)).toEqual([T0 + 3000, T0 + 4000]);
    expect(parseBackfillArgs(['--since', '2026-10-01'], (m) => { throw new Error(m); }).limit).toBe(500);
  });
});
