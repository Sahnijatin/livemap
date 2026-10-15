import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Summarizer, PROMPT_VERSION } from '../../src/summarize/summarizer.js';
import type { SummaryConfig, SummaryStatus } from '../../src/shared/summaries.js';
import type { ChangeSummary, FileModel } from '../../src/shared/types.js';

const KEY = 'sk-ant-SECRET-KEY-123';
const cfg: SummaryConfig = { provider: 'anthropic', apiKey: KEY, model: 'claude-haiku-5-5', monthlyTokenCap: 1_000_000 };
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sum-')); vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(home, { recursive: true, force: true }); });

const file = (p: string, extra: Partial<FileModel> = {}): FileModel => ({
  path: p, lang: 'typescript', size: 10, lines: 3, symbols: [{ name: 'run', qname: 'run', kind: 'function', signature: 'run(): void', line: 1, endLine: 2, exported: true, hash: 'h', children: [] }],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {}, ...extra,
});
const change = (extra: Partial<ChangeSummary> = {}): ChangeSummary => ({
  id: 1, path: 'a.ts', kind: 'modified', at: 1, lang: 'typescript',
  symbols: { added: [{ name: 'foo', qname: 'foo', kind: 'function', signature: 'foo()', line: 1 }], removed: [], modified: [] },
  routes: { added: [], removed: [] }, entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
  env: { added: [], removed: [] }, lines: { added: 1, removed: 0 }, hunks: [{ oldStart: 1, newStart: 1, lines: ['+function foo() {}'] }], truncated: false, ...extra,
});
const reply = (text = 'A summary.', i = 10, o = 5): Response => new Response(JSON.stringify({ content: [{ text }], usage: { input_tokens: i, output_tokens: o } }), { status: 200 });
const mkSum = (f: unknown, o: Partial<ConstructorParameters<typeof Summarizer>[1]> = {}, c = cfg): Summarizer =>
  new Summarizer(c, { home, fetchImpl: f as typeof fetch, ...o });
const bodyOf = (f: ReturnType<typeof vi.fn>, n = 0): { system: string; messages: { content: string }[]; max_tokens: number } => JSON.parse((f.mock.calls[n][1] as RequestInit).body as string);

describe('Summarizer', () => {
  it('summarizes a file with the specified prompt, caps the text and trims the result', async () => {
    const f = vi.fn(async () => reply('  ' + 'x'.repeat(400) + '  '));
    const s = mkSum(f);
    const text = Array.from({ length: 500 }, (_, i) => `line${i} ${'y'.repeat(60)}`).join('\n');
    const out = await s.summarizeFile(file('src/a.ts'), text);
    expect(out).toHaveLength(300);
    const b = bodyOf(f);
    expect(b.system).toBe('You explain source files to developers in one or two plain sentences. No markdown. Describe what the file does and how it fits in.');
    expect(b.max_tokens).toBe(120);
    expect(b.messages[0].content).toContain('src/a.ts');
    expect(b.messages[0].content).toContain('typescript');
    expect(b.messages[0].content).toContain('run: run(): void');
    expect(b.messages[0].content).not.toContain('line300 ');
    expect(b.messages[0].content.length).toBeLessThan(12_000 + 500);
  });

  it('summarizes a change with the specified prompt and caps hunks at 4000 chars', async () => {
    const f = vi.fn(async () => reply('Adds foo.'));
    const s = mkSum(f);
    const big = change({ hunks: [{ oldStart: 1, newStart: 1, lines: ['+' + 'z'.repeat(9000)] }] });
    expect(await s.summarizeChange(big, file('a.ts'))).toBe('Adds foo.');
    const b = bodyOf(f);
    expect(b.system).toBe('You describe a code change in one plain sentence under 20 words. No markdown.');
    expect(b.max_tokens).toBe(60);
    expect(b.messages[0].content).toContain('foo');
    expect((b.messages[0].content.match(/z/g) ?? []).length).toBe(3999); // the leading '+' is part of the 4000
  });

  it('skips changes with no symbol, route or entity change', async () => {
    const f = vi.fn(async () => reply());
    const none = change({ symbols: { added: [], removed: [], modified: [] } });
    expect(await mkSum(f).summarizeChange(none, file('a.ts'))).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('never sends secret, binary, tooLarge files or lang secret', async () => {
    const f = vi.fn(async () => reply());
    const s = mkSum(f);
    for (const fm of [file('.env', { lang: 'secret' }), file('a', { flags: { secret: true } }), file('b', { flags: { binary: true } }), file('c', { flags: { tooLarge: true } })]) {
      expect(await s.summarizeFile(fm, 'TOKEN=abc')).toBeNull();
      expect(await s.summarizeChange(change({ path: fm.path }), fm)).toBeNull();
    }
    expect(await s.summarizeChange(change({ lang: 'secret' }), null)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('a cache hit skips fetch and costs no tokens, also across instances', async () => {
    const f = vi.fn(async () => reply('Cached.', 10, 5));
    const a = mkSum(f);
    expect(await a.summarizeFile(file('a.ts'), 'code')).toBe('Cached.');
    expect(a.status().usedTokens).toBe(15);
    const g = vi.fn(async () => reply('Other.'));
    const b = mkSum(g);
    expect(await b.summarizeFile(file('a.ts'), 'code')).toBe('Cached.');
    expect(g).not.toHaveBeenCalled();
    expect(b.status().usedTokens).toBe(15);
    expect(PROMPT_VERSION).toBe(1);
    const dir = path.join(home, 'cache', 'summaries');
    const [name] = fs.readdirSync(dir);
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, name), 'utf8')).not.toContain(KEY);
  });

  it('enforces the cap: state becomes cap and nothing is sent', async () => {
    const f = vi.fn(async () => reply());
    const s = mkSum(f, {}, { ...cfg, monthlyTokenCap: 100 });
    expect(await s.summarizeFile(file('a.ts'), 'x'.repeat(2000))).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(s.status().state).toBe('cap');
  });

  it('persists usage with mode 0600 and rolls over at a month change', async () => {
    const f = vi.fn(async () => reply('S.', 10, 5));
    const s = mkSum(f);
    await s.summarizeFile(file('a.ts'), 'one');
    const usage = path.join(home, 'usage.json');
    expect(JSON.parse(fs.readFileSync(usage, 'utf8'))).toEqual({ month: '2026-10', tokens: 15 });
    expect(fs.statSync(usage).mode & 0o777).toBe(0o600);
    vi.setSystemTime(new Date('2026-11-01T00:00:01Z'));
    expect(s.status()).toMatchObject({ month: '2026-11', usedTokens: 0 });
    await s.summarizeFile(file('b.ts'), 'two');
    expect(JSON.parse(fs.readFileSync(usage, 'utf8'))).toEqual({ month: '2026-11', tokens: 15 });
  });

  it('loads existing usage for the current month and ignores a stale month', () => {
    fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ month: '2026-10', tokens: 400 }));
    expect(mkSum(vi.fn()).status().usedTokens).toBe(400);
    fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ month: '2026-09', tokens: 400 }));
    expect(mkSum(vi.fn()).status().usedTokens).toBe(0);
  });

  it('cap clears when the month rolls over', async () => {
    fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ month: '2026-10', tokens: 99_990 }));
    const f = vi.fn(async () => reply());
    const s = mkSum(f, {}, { ...cfg, monthlyTokenCap: 100_000 });
    expect(await s.summarizeFile(file('a.ts'), 'x'.repeat(400))).toBeNull();
    expect(s.status().state).toBe('cap');
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    expect(await s.summarizeFile(file('a.ts'), 'x'.repeat(400))).toBe('A summary.');
    expect(s.status().state).toBe('ready');
  });

  it('keeps concurrency at 2 with 10 queued items', async () => {
    let cur = 0; let max = 0;
    const f = vi.fn(async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 100)); cur--; return reply(); });
    const s = mkSum(f);
    const ps = Array.from({ length: 10 }, (_, i) => s.summarizeFile(file(`f${i}.ts`), `body ${i}`));
    expect(s.status().state).toBe('working');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all(ps)).toHaveLength(10);
    expect(f).toHaveBeenCalledTimes(10);
    expect(max).toBe(2);
    expect(s.status().state).toBe('ready');
  });

  it('retries a 429 once after 1 s and then succeeds', async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? new Response('', { status: 429 }) : reply('Done.')));
    const p = mkSum(f).summarizeFile(file('a.ts'), 'c');
    await vi.advanceTimersByTimeAsync(999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('Done.');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries with 1 s, 2 s, 4 s backoff and gives up after 3 retries', async () => {
    const f = vi.fn(async () => new Response('', { status: 503 }));
    const s = mkSum(f);
    const p = s.summarizeFile(file('a.ts'), 'c');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f).toHaveBeenCalledTimes(4);
    expect(await p).toBeNull();
    expect(s.status()).toMatchObject({ state: 'error', error: '503 server error' });
  });

  it('a thrown network error is retried', async () => {
    let n = 0;
    const f = vi.fn(async () => { if (n++ === 0) throw new TypeError('fetch failed'); return reply('Back.'); });
    const p = mkSum(f).summarizeFile(file('a.ts'), 'c');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('Back.');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a hang times out after 20 s and the next item proceeds', async () => {
    let n = 0;
    const f = vi.fn((_u: string, init: RequestInit) => {
      if (n++ === 0) return new Promise<Response>((_, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      return Promise.resolve(reply('Next.'));
    });
    const s = mkSum(f, { concurrency: 1 });
    const a = s.summarizeFile(file('a.ts'), 'one');
    const b = s.summarizeFile(file('b.ts'), 'two');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await a).toBeNull();
    expect(await b).toBe('Next.');
    expect(f).toHaveBeenCalledTimes(2);
    expect(s.status().state).toBe('ready');
  });

  it('a 401 sets the error state and pauses the queue for 60 s', async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? new Response(KEY, { status: 401 }) : reply('After.')));
    const s = mkSum(f);
    const statuses: SummaryStatus[] = [];
    s.on('status', (st: SummaryStatus) => statuses.push(st));
    expect(await s.summarizeFile(file('a.ts'), 'one')).toBeNull();
    expect(s.status()).toMatchObject({ state: 'error', error: '401 unauthorized' });
    const next = s.summarizeFile(file('b.ts'), 'two');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await next).toBe('After.');
    expect(f).toHaveBeenCalledTimes(2);
    expect(s.status().state).toBe('ready');
    expect(JSON.stringify(statuses)).not.toContain(KEY);
  });

  it('never exposes the api key in statuses or errors', async () => {
    const f = vi.fn(async () => new Response(`bad ${KEY}`, { status: 400 }));
    const s = mkSum(f);
    const seen: string[] = [];
    s.on('status', (st) => seen.push(JSON.stringify(st)));
    await s.summarizeFile(file('a.ts'), 'x');
    seen.push(JSON.stringify(s.status()));
    expect(seen.join()).toContain('400');
    expect(seen.join()).not.toContain(KEY);
  });

  it('emits status events and stop() resolves queued work with null', async () => {
    const f = vi.fn(() => new Promise<Response>(() => undefined));
    const s = mkSum(f, { concurrency: 1 });
    const states: string[] = [];
    s.on('status', (st: SummaryStatus) => states.push(st.state));
    s.summarizeFile(file('a.ts'), 'one');
    const queued = s.summarizeFile(file('b.ts'), 'two');
    expect(states).toContain('working');
    s.stop();
    expect(await queued).toBeNull();
    expect(await s.summarizeFile(file('c.ts'), 'three')).toBeNull();
  });

  it('cap is a hard stop: after it trips, a smaller job is not sent either', async () => {
    fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ month: '2026-10', tokens: 0 }));
    const f = vi.fn(async () => reply());
    const s = mkSum(f, {}, { ...cfg, monthlyTokenCap: 200 });
    expect(await s.summarizeFile(file('a.ts'), 'x'.repeat(2000))).toBeNull();
    expect(s.status().state).toBe('cap');
    expect(await s.summarizeFile(file('b.ts'), 'tiny')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(s.status().state).toBe('cap');
  });

  it('a reservation-only overshoot waits instead of tripping the cap', async () => {
    const small = 'a';
    const probe = vi.fn(async () => reply('p', 1, 1));
    const est = async (t: string): Promise<number> => { // estimate = chars/4 + maxTokens, read from a request body
      const s = mkSum(probe, {}, { ...cfg, monthlyTokenCap: 1e9 });
      await s.summarizeFile(file('p1.ts'), t);
      const b = bodyOf(probe, probe.mock.calls.length - 1);
      return Math.ceil((b.system.length + b.messages[0].content.length) / 4) + b.max_tokens;
    };
    const e = await est(small);
    fs.rmSync(path.join(home, 'cache'), { recursive: true, force: true });
    fs.rmSync(path.join(home, 'usage.json'), { force: true });
    let release: () => void = () => undefined;
    let n = 0;
    const f = vi.fn(async () => { if (n++ === 0) await new Promise<void>((r) => { release = r; }); return reply('ok', 1, 1); });
    const s = mkSum(f, { concurrency: 2 }, { ...cfg, monthlyTokenCap: e * 2 - 1 }); // one job fits, two reservations do not
    const a = s.summarizeFile(file('a1.ts'), small);
    const b = s.summarizeFile(file('b1.ts'), small);
    await vi.advanceTimersByTimeAsync(10);
    expect(f).toHaveBeenCalledTimes(1);
    expect(s.status().state).toBe('working');
    release();
    expect(await a).toBe('ok');
    expect(await b).toBe('ok');
    expect(f).toHaveBeenCalledTimes(2);
    expect(s.status().state).toBe('ready');
  });

  it('re-reads the usage file before each cap check', async () => {
    const f = vi.fn(async () => reply());
    const s = mkSum(f, {}, { ...cfg, monthlyTokenCap: 1000 });
    fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ month: '2026-10', tokens: 990 }));
    expect(await s.summarizeFile(file('a.ts'), 'x'.repeat(400))).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(s.status().state).toBe('cap');
  });

  it('the pause timer is the authority: a frozen injected clock still resumes after 60 s', async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? new Response('', { status: 401 }) : reply('After.')));
    const s = mkSum(f, { now: () => Date.parse('2026-10-15T12:00:00Z') });
    expect(await s.summarizeFile(file('a.ts'), 'one')).toBeNull();
    const next = s.summarizeFile(file('b.ts'), 'two');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await next).toBe('After.');
  });

  it('stop() during a retry backoff settles the job with null', async () => {
    const f = vi.fn(async () => new Response('', { status: 503 }));
    const s = mkSum(f);
    const p = s.summarizeFile(file('a.ts'), 'c');
    await vi.advanceTimersByTimeAsync(10);
    s.stop();
    expect(await p).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('bounds the queue at 200 by dropping the oldest queued job', async () => {
    const f = vi.fn(() => new Promise<Response>(() => undefined));
    const s = mkSum(f, { concurrency: 1 });
    const ps = Array.from({ length: 202 }, (_, i) => s.summarizeFile(file(`q${i}.ts`), `body ${i}`));
    // job 0 is running; queue holds 201 -> the oldest queued (job 1) was dropped at the 201st queued job
    expect(await ps[1]).toBeNull();
    s.stop();
  });
});
