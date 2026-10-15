import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { HistoryStore } from '../../src/history/store.js';
import { projectDir } from '../../src/history/paths.js';
import { buildExport, pathScrubber } from '../../src/export/export.js';
import { emptyState } from '../../src/shared/state.js';
import type { ProjectState } from '../../src/shared/state.js';
import type { ExportPayload } from '../../src/shared/export.js';
import type { ServerMessage } from '../../src/shared/protocol.js';
import type { AgentEvent, AgentSession, ChangeSummary, FileModel } from '../../src/shared/types.js';

const UI = '<!doctype html><html><head><title>LiveMap</title></head><body><div id="root"></div><script type="module">boot()</script></body></html>';
const DATA_RE = /<script type="application\/octet-stream" id="livemap-data">([^<]*)<\/script>/;

let home: string;
let root: string;
let clock = Date.UTC(2026, 9, 15, 9, 30);

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-exp-home-')));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-exp-root-')));
});
afterEach(() => {
  for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true });
});

const file = (p: string, flags: FileModel['flags'] = {}): FileModel => ({
  path: p, lang: 'typescript', size: 10, lines: 3, symbols: [],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags,
});
const change = (id: number, p: string): ChangeSummary => ({
  id, path: p, kind: 'modified', at: id, lang: 'typescript',
  symbols: { added: [], removed: [], modified: [] }, routes: { added: [], removed: [] },
  entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
  env: { added: [], removed: [] }, lines: { added: 1, removed: 0 }, hunks: [], truncated: false,
});
const event = (id: number, sessionId: string, text = `said ${id}`): AgentEvent => ({ id, agent: 'claude-code', sessionId, at: id, type: 'message', text });
const session = (id: string, cwd: string, transcriptPath?: string): AgentSession => ({
  id, agent: 'claude-code', title: `t ${id}`, cwd, startedAt: 1, lastAt: 2, status: 'working', hooks: true, ...(transcriptPath ? { transcriptPath } : {}),
});

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function startState(files: FileModel[]): ProjectState {
  return { ...emptyState(root, path.basename(root)), files };
}

/** Records the messages in one run (after its start state) and closes the store. */
async function record(files: FileModel[], msgs: ServerMessage[]): Promise<void> {
  const store = await HistoryStore.open(root, { home, now: () => (clock += 1000) });
  await store.startRun(startState(files));
  for (const m of msgs) store.append(m);
  await store.close();
}

function decode(html: string): { text: string; payload: ExportPayload } {
  const m = DATA_RE.exec(html);
  expect(m).not.toBeNull();
  const text = zlib.gunzipSync(Buffer.from(m![1], 'base64')).toString('utf8');
  return { text, payload: JSON.parse(text) as ExportPayload };
}

const plain = (msgs: ExportPayload['messages']) => msgs.map(([, , msg]) => msg);

describe('buildExport', () => {
  it('embeds a gzip, base64 payload that round-trips the recorded history', async () => {
    write('a.ts', 'export const a = 1;\n');
    const msgs: ServerMessage[] = [
      { type: 'agentEvent', event: event(1, 's1') },
      { type: 'change', change: change(1, 'a.ts'), files: [file('a.ts')], removed: [] },
      { type: 'attribution', changeId: 1, attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'exact' } },
      { type: 'usedBy', usedBy: [{ file: 'a.ts', symbol: 'a', usedIn: ['b.ts'] }] },
    ];
    await record([file('a.ts'), file('b.ts')], msgs);
    const res = await buildExport(root, { home, code: true, uiHtml: UI });
    const { payload } = decode(res.html);
    expect(payload.version).toBe(1);
    expect(payload.name).toBe(path.basename(root));
    expect(typeof payload.exportedAt).toBe('number');
    // The first record is the run's start state (a hello), then every recorded message in order.
    expect(payload.messages[0][2].type).toBe('hello');
    expect(plain(payload.messages.slice(1))).toEqual(msgs);
    expect(payload.messages.map(m => m[0])).toEqual([1, 2, 3, 4, 5]);
    expect(res.events).toBe(5);
    expect(payload.code).toEqual({ 'a.ts': 'export const a = 1;\n' });
    expect(res.files).toBe(1);
    // The payload sits before the app script inside the page, which is otherwise unchanged.
    expect(res.html.startsWith('<!doctype html><html><head><title>LiveMap</title></head><body><div id="root"></div>')).toBe(true);
  });

  it('leaves out the code map with code: false', async () => {
    write('a.ts', 'const a = 1;\n');
    await record([file('a.ts')], [{ type: 'change', change: change(1, 'a.ts'), files: [file('a.ts')], removed: [] }]);
    const res = await buildExport(root, { home, code: false, uiHtml: UI });
    const { payload } = decode(res.html);
    expect('code' in payload).toBe(false);
    expect(res.files).toBe(0);
  });

  it('code: false leaves out diff hunks and tool inputs and outputs too', async () => {
    write('a.ts', 'const a = 1;\n');
    const c = { ...change(1, 'a.ts'), hunks: [{ oldStart: 1, newStart: 1, lines: ['-SECRET_OLD', '+SECRET_NEW'] }] };
    const ev: AgentEvent = { ...event(1, 's1'), type: 'tool_start', tool: { name: 'Edit', label: 'Edit a.ts', input: { old_string: 'SECRET_IN' }, output: 'SECRET_OUT', paths: ['a.ts'] } };
    await record([file('a.ts')], [{ type: 'agentEvent', event: ev }, { type: 'change', change: c, files: [file('a.ts')], removed: [] }]);
    const { text } = decode((await buildExport(root, { home, code: false, uiHtml: UI })).html);
    expect(text).not.toMatch(/SECRET_/);
    expect(text).toContain('Edit a.ts');
    const { text: withCode } = decode((await buildExport(root, { home, code: true, uiHtml: UI })).html);
    expect(withCode).toContain('SECRET_NEW');
  });

  it('code: false reduces shell labels to the command name and removes code from agent text (#20)', async () => {
    write('a.ts', 'const a = 1;\n');
    const tool = (id: number, label: string): AgentEvent => ({ ...event(id, 's1'), type: 'tool_start', tool: { name: 'Bash', label, paths: [] } });
    const said = (id: number, type: AgentEvent['type'], text: string): AgentEvent => ({ ...event(id, 's1'), type, text });
    const intent = 'Adds `CODE_INLINE()` to a.ts';
    const c = { ...change(1, 'a.ts'), attribution: { agent: 'claude-code' as const, sessionId: 's1', confidence: 'exact' as const, intent } };
    await record([file('a.ts')], [
      { type: 'session', session: { ...session('s1', root), title: 'Fix `CODE_TITLE` now' } },
      { type: 'agentEvent', event: tool(1, '$ FOO=1 ./node_modules/.bin/vitest run CODE_ARG') },
      { type: 'agentEvent', event: tool(2, '$ (command touching .env)') },
      { type: 'agentEvent', event: said(3, 'prompt', 'Please change `CODE_A` here') },
      { type: 'agentEvent', event: said(4, 'message', 'Done:\n```ts\nconst CODE_B = 1;\n```\nAll set.') },
      { type: 'agentEvent', event: said(5, 'thinking', 'Maybe ```\nCODE_C unclosed') },
      { type: 'agentEvent', event: said(6, 'commit', 'Add `a` helper') },
      { type: 'change', change: c, files: [file('a.ts')], removed: [] },
      { type: 'attribution', changeId: 1, attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'exact', intent } },
    ]);
    const { text, payload } = decode((await buildExport(root, { home, code: false, uiHtml: UI })).html);
    expect(text).not.toMatch(/CODE_/);
    const events = plain(payload.messages).flatMap(m => (m.type === 'agentEvent' ? [m.event] : []));
    expect(events.map(e => e.tool?.label ?? e.text)).toEqual([
      '$ vitest', '$ (command touching .env)', 'Please change [code removed] here', 'Done:\n[code removed]\nAll set.', 'Maybe [code removed]', 'Add `a` helper',
    ]);
    const attributions = plain(payload.messages).flatMap(m => (m.type === 'attribution' ? [m.attribution.intent] : m.type === 'change' ? [m.change.attribution?.intent] : []));
    expect(attributions).toEqual(['Adds [code removed] to a.ts', 'Adds [code removed] to a.ts']);
    const { text: withCode } = decode((await buildExport(root, { home, code: true, uiHtml: UI })).html);
    for (const s of ['CODE_ARG', 'CODE_A', 'CODE_B', 'CODE_C', 'CODE_INLINE', 'CODE_TITLE']) expect(withCode).toContain(s);
  });

  it('with a session, keeps that session\'s events, its attributed changes, and context within its span', async () => {
    for (const f of ['a.ts', 'b.ts', 'c.ts']) write(f, `// ${f}\n`);
    const msgs: ServerMessage[] = [
      { type: 'agentEvent', event: event(1, 's2') },
      { type: 'change', change: change(1, 'c.ts'), files: [file('c.ts')], removed: [] },
      { type: 'attribution', changeId: 1, attribution: { agent: 'claude-code', sessionId: 's2', confidence: 'exact' } },
      { type: 'session', session: session('s1', root) },
      { type: 'agentEvent', event: event(2, 's1') },
      { type: 'agentEvent', event: event(3, 's2') },
      { type: 'change', change: change(2, 'a.ts'), files: [file('a.ts')], removed: [] },
      { type: 'attribution', changeId: 2, attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'exact' } },
      { type: 'change', change: change(3, 'b.ts'), files: [file('b.ts')], removed: [] },
      { type: 'attribution', changeId: 3, attribution: { agent: 'claude-code', sessionId: 's2', confidence: 'likely' } },
      { type: 'usedBy', usedBy: [] },
      { type: 'agentEvent', event: event(4, 's1') },
      { type: 'control', control: { paused: true, flags: [] } },
    ];
    await record([file('a.ts'), file('b.ts'), file('c.ts')], msgs);
    const res = await buildExport(root, { home, session: 's1', code: true, uiHtml: UI });
    const { payload } = decode(res.html);
    const types = plain(payload.messages).map(m => m.type);
    const events = plain(payload.messages).filter(m => m.type === 'agentEvent').map(m => (m as { event: AgentEvent }).event);
    expect(events.map(e => e.sessionId)).toEqual(['s1', 's1']);
    const changes = plain(payload.messages).filter(m => m.type === 'change').map(m => (m as { change: ChangeSummary }).change.id);
    expect(changes).toEqual([2]);
    expect(types).toContain('usedBy');
    expect(types).not.toContain('control'); // after the session's last event
    expect(types).toContain('attribution');
    // The initial state is the state just before the session's first event, without other sessions' events.
    expect(payload.messages[0][0]).toBe(6);
    expect(payload.initial.changes).toEqual([]); // s2's earlier change is not this session's
    expect(payload.initial.events).toEqual([]);
    expect(Object.keys(payload.code ?? {})).toEqual(['a.ts']);
    expect(res.events).toBe(payload.messages.length);
  });

  it('embeds a file holding a closing script tag safely', async () => {
    const evil = 'const s = "</script><script>alert(1)</script>";\n';
    write('evil.ts', evil);
    await record([file('evil.ts')], [{ type: 'change', change: change(1, 'evil.ts'), files: [file('evil.ts')], removed: [] }]);
    const res = await buildExport(root, { home, code: true, uiHtml: UI });
    expect(res.html).not.toContain('</script><script>alert');
    expect(res.html.match(/<\/script>/g)).toHaveLength(2); // the data block's and the app script's own
    expect(decode(res.html).payload.code!['evil.ts']).toBe(evil);
  });

  it('never embeds secret files or env values', async () => {
    write('.env', 'API_KEY=hunter2-not-for-export\n');
    write('a.ts', 'process.env.API_KEY;\n');
    await record([file('a.ts'), file('.env', { secret: true })], [
      { type: 'change', change: change(1, '.env'), files: [file('.env', { secret: true })], removed: [] },
      { type: 'change', change: change(2, 'a.ts'), files: [file('a.ts')], removed: [] },
    ]);
    const res = await buildExport(root, { home, code: true, uiHtml: UI });
    const { text, payload } = decode(res.html);
    expect(Object.keys(payload.code!)).toEqual(['a.ts']);
    expect(text).not.toContain('hunter2');
    expect(res.html).not.toContain('hunter2');
  });

  it('never contains the absolute project root', async () => {
    write('a.ts', 'x\n');
    const elsewhere = path.join(os.tmpdir(), 'other-project');
    await record([file('a.ts')], [
      { type: 'session', session: session('s1', root, path.join(home, '.claude', 'projects', 'x', 's1.jsonl')) },
      { type: 'session', session: session('s2', path.join(root, 'pkg'), path.join(root, '.logs', 's2.jsonl')) },
      { type: 'session', session: session('s3', elsewhere) },
      { type: 'agentEvent', event: event(1, 's1', `Edited ${path.join(root, 'a.ts')} in ${root}`) },
      { type: 'change', change: change(1, 'a.ts'), files: [file('a.ts')], removed: [] },
      { type: 'domain', domain: { ...emptyState('', '').domain, env: [{ name: 'API_KEY', files: [path.join(root, 'a.ts')], inExample: false, definedInEnvFile: true }] } },
    ]);
    const res = await buildExport(root, { home, code: true, uiHtml: UI });
    const { text, payload } = decode(res.html);
    expect(text).not.toContain(root);
    expect(res.html).not.toContain(root);
    const sessions = plain(payload.messages).filter(m => m.type === 'session').map(m => (m as { session: AgentSession }).session);
    expect(sessions.map(s => [s.cwd, s.transcriptPath])).toEqual([['.', 's1.jsonl'], ['pkg', '.logs/s2.jsonl'], ['other-project', undefined]]);
    const hello = payload.messages[0][2] as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.root).toBe(path.basename(root));
    const ev = plain(payload.messages).find(m => m.type === 'agentEvent') as { event: AgentEvent };
    expect(ev.event.text).toBe(`Edited a.ts in ${path.basename(root)}`);
    const dom = plain(payload.messages).find(m => m.type === 'domain') as { domain: { env: { files: string[] }[] } };
    expect(dom.domain.env[0].files).toEqual(['a.ts']);
  });

  it('scrubs a root given with a trailing slash, and sibling paths next to the root', async () => {
    write('a.ts', 'x\n');
    const parent = path.dirname(root);
    await record([file('a.ts')], [
      { type: 'agentEvent', event: event(1, 's1', `Copied ${path.join(parent, 'app-old', 'x.ts')} into ${root}/a.ts`) },
      { type: 'change', change: change(1, 'a.ts'), files: [file('a.ts')], removed: [] },
    ]);
    const res = await buildExport(`${root}/`, { home, code: true, uiHtml: UI });
    const { text, payload } = decode(res.html);
    expect(text).not.toContain(root);
    expect(text).not.toContain(`${parent}/`);
    const ev = plain(payload.messages).find(m => m.type === 'agentEvent') as { event: AgentEvent };
    expect(ev.event.text).toBe('Copied app-old/x.ts into a.ts');
  });

  it('keeps the code map as file content', async () => {
    write('a.ts', `// built in ${path.join(root, 'out')}\n`);
    await record([file('a.ts')], [{ type: 'change', change: change(1, 'a.ts'), files: [file('a.ts')], removed: [] }]);
    const { payload } = decode((await buildExport(root, { home, code: true, uiHtml: UI })).html);
    expect(payload.code!['a.ts']).toBe(`// built in ${path.join(root, 'out')}\n`);
  });

  it('starts a session export at a trimmed run start with the project name and the state there', async () => {
    write('a.ts', 'x\n');
    await record([file('a.ts')], [{ type: 'agentEvent', event: event(1, 's1') }, { type: 'agentEvent', event: event(2, 's1') }]);
    // Drop the run's start record and its snapshot, as the cap's trim does, and the stale index.
    const dir = projectDir(root, home);
    const events = fs.readdirSync(dir).find(f => f.startsWith('events-'))!;
    const lines = fs.readFileSync(path.join(dir, events), 'utf8').split('\n');
    fs.writeFileSync(path.join(dir, events), lines.slice(1).join('\n'));
    fs.rmSync(path.join(dir, 'index.json'), { force: true });
    const store = await HistoryStore.open(root, { home });
    await store.startRun(startState([file('a.ts')])); // gives seq 2 a snapshot to start from
    await store.close();
    fs.rmSync(path.join(dir, 'snapshots', '1.json.gz'), { force: true });
    const snap = path.join(dir, 'snapshots', '4.json.gz');
    fs.renameSync(snap, path.join(dir, 'snapshots', '2.json.gz'));
    const { payload } = decode((await buildExport(root, { home, session: 's1', code: false, uiHtml: UI })).html);
    expect(payload.initial.name).toBe(path.basename(root));
    expect(payload.initial.files.map(f => f.path)).toEqual(['a.ts']);
    expect(payload.messages[0][0]).toBe(2);
  });

  it('a session export starts from the nearest earlier record when the one just before it was corrupt', async () => {
    write('a.ts', 'x\n');
    await record([file('a.ts')], [
      { type: 'agentEvent', event: event(1, 's2') },
      { type: 'usedBy', usedBy: [] },
      { type: 'agentEvent', event: event(2, 's1') },
    ]);
    // Corrupt the record just before s1's first event (seq 3), and drop the stale index.
    const dir = projectDir(root, home);
    const events = fs.readdirSync(dir).find(f => f.startsWith('events-'))!;
    const lines = fs.readFileSync(path.join(dir, events), 'utf8').split('\n');
    const at = lines.findIndex(l => l.includes('"type":"usedBy"'));
    expect(at).toBeGreaterThan(0);
    lines[at] = '{"torn';
    fs.writeFileSync(path.join(dir, events), lines.join('\n'));
    fs.rmSync(path.join(dir, 'index.json'), { force: true });
    const { payload } = decode((await buildExport(root, { home, session: 's1', code: false, uiHtml: UI })).html);
    expect(plain(payload.messages).filter(m => m.type === 'agentEvent').map(m => (m as { event: AgentEvent }).event.sessionId)).toEqual(['s1']);
    expect(payload.initial.files.map(f => f.path)).toEqual(['a.ts']);
  });

  it('reports a store that cannot be read instead of "no history"', async () => {
    const dir = projectDir(root, home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snapshots'), 'not a directory');
    await expect(buildExport(root, { home, code: true, uiHtml: UI })).rejects.toThrow(/^History is unavailable: could not open history files \(ENOTDIR\)$/);
  });

  it('throws when nothing is recorded, without creating the history directory', async () => {
    await expect(buildExport(root, { home, code: true, uiHtml: UI })).rejects.toThrow('No history recorded for this project yet. Run livemap here first.');
    expect(fs.existsSync(path.join(home, 'projects'))).toBe(false);
  });

  it('Review Focus 5: 50,000 events and 2,000 files in under 10 s and under 60 MB', async () => {
    const N_FILES = 2000;
    const N = 50_000;
    const body = 'export function f(x: number): number {\n  return x * 2;\n}\n'.repeat(40);
    const files: FileModel[] = [];
    for (let i = 0; i < N_FILES; i++) {
      const rel = `src/m${i % 40}/f${i}.ts`;
      write(rel, `// file ${i}\n${body}`);
      files.push(file(rel));
    }
    const store = await HistoryStore.open(root, { home, now: () => (clock += 1) });
    await store.startRun(startState(files));
    let ev = 0;
    for (let i = 0; i < N - 1; i++) {
      if (i % 25 === 0) {
        const f = files[(i / 25) % N_FILES];
        store.append({ type: 'change', change: change(i, f.path), files: [f], removed: [] });
      } else {
        store.append({ type: 'agentEvent', event: { ...event(++ev, 's1', `step ${i}: reading the code and deciding what to change next`), type: i % 3 ? 'tool_start' : 'message' } });
      }
    }
    await store.close();

    const t0 = performance.now();
    const res = await buildExport(root, { home, code: true, uiHtml: UI });
    const ms = performance.now() - t0;
    const mb = Buffer.byteLength(res.html) / 1024 / 1024;
    console.log(`[export perf] ${res.events} records, ${res.files} files: ${ms.toFixed(0)} ms, ${mb.toFixed(2)} MB`);
    expect(res.events).toBe(N);
    expect(res.files).toBe(N_FILES);
    expect(ms).toBeLessThan(10_000);
    expect(mb).toBeLessThan(60);
  }, 120_000);
});

describe('pathScrubber', () => {
  const win = pathScrubber(['C:\\Users\\u\\proj'], 'proj', { caseInsensitive: true });
  const posix = pathScrubber(['/home/u/app/'], 'app', { caseInsensitive: false });

  it('matches a Windows root with forward slashes, backslashes and any drive letter case', () => {
    expect(win.text('C:/Users/u/proj/src/a.ts')).toBe('src/a.ts');
    expect(win.text('C:\\Users\\u\\proj\\src\\a.ts')).toBe('src\\a.ts');
    expect(win.text('c:\\users\\U\\Proj\\x')).toBe('x');
    expect(win.text('cd C:/Users/u/proj')).toBe('cd proj');
    expect(win.text('see C:\\Users\\u\\other\\y.ts')).toBe('see other\\y.ts');
  });

  it('handles a trailing-slash root, siblings and the bare root', () => {
    expect(posix.text('/home/u/app/src/a.ts')).toBe('src/a.ts');
    expect(posix.text('in /home/u/app.')).toBe('in app.');
    expect(posix.text('/home/u/app-old/x')).toBe('app-old/x');
    expect(posix.text('"/home/u/app"')).toBe('"app"');
  });

  it('leaves a longer path that only contains the root mid-path alone', () => {
    expect(posix.text('/mnt/bk/home/u/app/x')).toBe('/mnt/bk/home/u/app/x');
    expect(posix.text('backup:/mnt/bk/home/u/app-old')).toBe('backup:/mnt/bk/home/u/app-old');
    expect(win.text('D:/mirror/C:/Users/u/proj/x')).toBe('D:/mirror/C:/Users/u/proj/x');
  });

  it('scrubs keys and nested values', () => {
    expect(posix.value({ '/home/u/app/a.ts': ['/home/u/app', { p: '/home/u/b' }], n: 1 })).toEqual({ 'a.ts': ['app', { p: 'b' }], n: 1 });
  });
});
