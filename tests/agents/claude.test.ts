import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLine, ClaudeTailer } from '../../src/agents/claude.js';
import type { RawAgentEvent } from '../../src/shared/types.js';

const ROOT = '/proj';
const raw = fs.readFileSync(path.join(__dirname, '../fixtures/agents/claude-session.jsonl'), 'utf8');
const fixture = (now = Date.now()) => raw.replaceAll('__ROOT__', ROOT).replaceAll('__NOW__', new Date(now).toISOString()).split('\n').filter(Boolean);

async function waitFor(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('parseClaudeLine', () => {
  it('maps fixture lines to events', () => {
    const evs = fixture().flatMap((l) => parseClaudeLine(l, ROOT));
    expect(evs.map((e) => e.type)).toEqual(['prompt', 'thinking', 'message', 'tool_start', 'tool_end', 'message']);
    expect(evs[0].text).toBe('Add a status filter');
    expect(evs[0].agent).toBe('claude-code');
    expect(evs[0].sessionId).toBe('s1');
    expect(typeof evs[0].at).toBe('number');
    expect(evs[3].tool).toMatchObject({ id: 'tu1', name: 'Edit', label: 'Edit src/a.ts', paths: ['src/a.ts'] });
    expect(evs[4].tool).toEqual({ id: 'tu1', name: '', label: '', ok: true, output: 'edited\nok', paths: [] });
    expect(evs[5].subagent).toBe(true);
    expect(evs[0].subagent).toBeFalsy();
    expect(parseClaudeLine('{"type":', ROOT)).toEqual([]);
  });
  it('flags errors, truncates output, skips command tags, redacts secrets', () => {
    const user = (content: unknown) => JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', sessionId: 's', message: { content } });
    const [e] = parseClaudeLine(user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5000), is_error: true }]), ROOT);
    expect(e.tool?.ok).toBe(false);
    expect(e.tool?.output?.length).toBe(4000);
    expect(parseClaudeLine(user('<command-name>/x</command-name>'), ROOT)).toEqual([]);
    expect(parseClaudeLine(user('<local-command-stdout>hi</local-command-stdout>'), ROOT)).toEqual([]);
    const asst = JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', sessionId: 's', message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/proj/.env', content: 'SECRET=1' } }] } });
    const [s] = parseClaudeLine(asst, ROOT);
    expect(JSON.stringify(s.tool?.input)).not.toContain('SECRET');
  });
});

describe('C1: claude transcript secrets', () => {
  const asst = (name: string, input: unknown) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', sessionId: 's', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
  const user = (content: unknown) => JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', sessionId: 's', message: { content } });
  it('MultiEdit of .env keeps only the path; cat .env* keeps neither command nor value', () => {
    const [m] = parseClaudeLine(asst('MultiEdit', { file_path: '/proj/.env', edits: [{ old_string: 'A=1', new_string: 'A=2' }] }), ROOT);
    expect(m.tool?.input).toEqual({ file_path: '/proj/.env' });
    const [b] = parseClaudeLine(asst('Bash', { command: 'cat .env*' }), ROOT);
    expect(b.tool?.input).toEqual({ command: '<touches a secret file>' });
    expect(b.tool?.label).toBe('$ (command touching .env)');
  });
  it('drops a tool_result that names a secret file', () => {
    const [e] = parseClaudeLine(user([{ type: 'tool_result', tool_use_id: 't', content: '.env:3:STRIPE_KEY=sk_live_1' }]), ROOT);
    expect(e.tool?.output).toBeUndefined();
  });
});

describe('ClaudeTailer', () => {
  let dir = '';
  let tailer: ClaudeTailer | undefined;
  afterEach(() => {
    tailer?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const setup = (opts = {}) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-claude-'));
    const file = path.join(dir, 't.jsonl');
    const got: RawAgentEvent[] = [];
    return { file, got, make: () => { tailer = new ClaudeTailer(file, ROOT, { pollMs: 20, ...opts }); tailer.on('events', (e: RawAgentEvent[]) => got.push(...e)); return tailer; } };
  };

  it('tails appended lines, handles split lines and truncation', async () => {
    const { file, got, make } = setup();
    const lines = fixture();
    fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
    make().start();
    await waitFor(() => got.length === 3);
    const rest = lines.slice(3).join('\n') + '\n';
    const cut = rest.indexOf('"type":"tool_result"') + 10;
    fs.appendFileSync(file, rest.slice(0, 40));
    await sleep(60);
    fs.appendFileSync(file, rest.slice(40, cut));
    await sleep(100);
    fs.appendFileSync(file, rest.slice(cut));
    await waitFor(() => got.length === 6);
    await sleep(80);
    expect(got.map((e) => e.type)).toEqual(['prompt', 'thinking', 'message', 'tool_start', 'tool_end', 'message']);

    fs.truncateSync(file, 0);
    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
    await waitFor(() => got.length === 9);
    await sleep(80);
    expect(got.length).toBe(9);
    expect(got.slice(6).map((e) => e.type)).toEqual(['prompt', 'thinking', 'message']);
  });

  it('skips backfill entries older than backfillMs', async () => {
    const { file, got, make } = setup({ backfillMs: 60_000 });
    const old = fixture(Date.now() - 3_600_000)[0];
    const fresh = fixture()[2];
    fs.writeFileSync(file, old + '\n' + fresh + '\n');
    make().start();
    await waitFor(() => got.length >= 2);
    await sleep(80);
    expect(got.map((e) => e.type)).toEqual(['thinking', 'message']);
  });

  it('drops the partial first line when backfilling from mid-file', async () => {
    const { file, got, make } = setup();
    const lines = fixture();
    const body = lines.slice(0, 3).join('\n') + '\n';
    fs.writeFileSync(file, body);
    const last = lines[2];
    // window starts inside the last line: its head is discarded, so nothing parses
    tailer = new ClaudeTailer(file, ROOT, { pollMs: 20, maxBackfillBytes: last.length - 10 });
    tailer.on('events', (e: RawAgentEvent[]) => got.push(...e));
    tailer.start();
    await sleep(150);
    expect(got).toEqual([]);
    fs.appendFileSync(file, lines[3] + '\n');
    await waitFor(() => got.length === 1);
    expect(got[0].type).toBe('tool_start');
  });

  it('I4: resumes at startOffset without backfill filtering', async () => {
    const { file, got } = setup({ backfillMs: 60_000 });
    const lines = fixture(Date.now() - 3_600_000);
    fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
    tailer = new ClaudeTailer(file, ROOT, { pollMs: 20, startOffset: Buffer.byteLength(lines[0] + '\n') });
    tailer.on('events', (e: RawAgentEvent[]) => got.push(...e));
    tailer.start();
    await waitFor(() => got.length === 2);
    await sleep(60);
    expect(got.map((e) => e.type)).toEqual(['thinking', 'message']);
    expect(tailer.position).toBe(fs.statSync(file).size);
  });

  it('I4: stats before reading and backs off while the file does not grow; growth resets the pace', async () => {
    const { file, got } = setup();
    fs.writeFileSync(file, fixture()[0] + '\n');
    const open = vi.spyOn(fs.promises, 'open');
    const stat = vi.spyOn(fs.promises, 'stat');
    try {
      // 13 ms: distinct from the 10 ms waitFor step, so the pace can be read from the scheduled delays.
      tailer = new ClaudeTailer(file, ROOT, { pollMs: 13, idleAfterMs: 100, idlePollMs: 250 });
      tailer.on('events', (e: RawAgentEvent[]) => got.push(...e));
      const t0 = tailer;
      t0.start();
      await waitFor(() => got.length === 1);
      const active = t0.lastActiveAt;
      await sleep(200);
      const opens = open.mock.calls.length;
      const before = stat.mock.calls.length;
      await sleep(500);
      // Idle: about two polls in 500 ms at the 250 ms pace (not 50 at 10 ms), and no reads.
      expect(stat.mock.calls.length - before).toBeLessThanOrEqual(3);
      expect(open.mock.calls.length).toBe(opens);
      expect(t0.lastActiveAt).toBe(active);
      fs.appendFileSync(file, fixture()[0] + '\n');
      await waitFor(() => got.length === 2, 1000);
      expect(t0.lastActiveAt).toBeGreaterThan(active);
      // Growth reset the pace: the tailer schedules its next poll at pollMs, not the idle pace.
      // Reading the scheduled delay, not wall-clock poll counts, keeps this true on a loaded runner.
      const timers = vi.spyOn(globalThis, 'setTimeout');
      try {
        fs.appendFileSync(file, fixture()[0] + '\n');
        await waitFor(() => got.length === 3, 1000);
        await waitFor(() => timers.mock.calls.some((c) => c[1] === 13), 1000);
      } finally {
        timers.mockRestore();
      }
    } finally {
      open.mockRestore();
      stat.mockRestore();
    }
  });

  it('I4: position excludes a pending partial line, so a resumed tailer reads it whole', async () => {
    const { file, got, make } = setup();
    const [a, b] = [fixture()[0], fixture()[0]];
    fs.writeFileSync(file, a + '\n' + b.slice(0, 20));
    const t = make();
    t.start();
    await waitFor(() => got.length === 1);
    await sleep(60);
    expect(t.position).toBe(Buffer.byteLength(a + '\n'));
    t.stop();
    fs.appendFileSync(file, b.slice(20) + '\n');
    const again: RawAgentEvent[] = [];
    tailer = new ClaudeTailer(file, ROOT, { pollMs: 20, startOffset: t.position });
    tailer.on('events', (e: RawAgentEvent[]) => again.push(...e));
    tailer.start();
    await waitFor(() => again.length === 1);
    expect(again[0].type).toBe('prompt');
  });
});
