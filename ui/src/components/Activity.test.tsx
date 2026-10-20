// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentEvent } from '@shared/types.js';
import { useStore } from '../store';
import { change, event, file, session, emptyDomain } from '../fixtures';
import { Activity } from './Activity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const T = Date.now() - 30_000;
const s1 = session({ id: 's1', title: 'Add an orders page', status: 'working', startedAt: T - 1000 });
const events: AgentEvent[] = [
  event({ id: 1, at: T, type: 'prompt', text: 'Add an orders page with filters' }),
  event({ id: 2, at: T + 1000, type: 'message', text: 'I will add an order service first.' }),
  event({ id: 3, at: T + 2000, type: 'tool_start', tool: { id: 't1', name: 'Read', label: 'Read src/db.ts', paths: ['src/db.ts'] } }),
  event({ id: 4, at: T + 2500, type: 'tool_end', tool: { id: 't1', name: 'Read', label: 'Read src/db.ts', ok: true, output: 'export const db = {}', paths: ['src/db.ts'] } }),
  event({ id: 5, at: T + 9000, type: 'tool_start', tool: { id: 't2', name: 'Bash', label: 'Run npm test', paths: [] } }),
];
const created = change('src/orders.ts', 'created', {
  at: T + 5000,
  symbols: { added: [{ name: 'createOrder', qname: 'createOrder', kind: 'function', signature: 'createOrder()', line: 1 }], removed: [], modified: [] },
  lines: { added: 12, removed: 0 },
  hunks: [{ oldStart: 0, newStart: 1, lines: ['+export function createOrder() {}'] }],
  attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'exact', eventId: 3, intent: 'Add an order service' },
});

function mount(changes = [created]) {
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/orders.ts')], changes, usedBy: [], domain: emptyDomain(), indexing: false,
    events, sessions: [s1], control: { paused: false, flags: [] },
  });
  act(() => root.render(<Activity />));
}

beforeEach(() => {
  useStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Activity', () => {
  it('shows the prompt bubble and a turn header with the session title', () => {
    mount();
    expect(host.querySelector('.f-prompt')?.textContent).toContain('Add an orders page with filters');
    const header = host.querySelector('.turn-h');
    expect(header?.textContent).toContain('Add an orders page');
    expect(header?.textContent).toContain('Claude Code');
  });

  it('shows a spinner for a running tool and an ok icon for a finished one', () => {
    mount();
    const tools = [...host.querySelectorAll('.f-tool')];
    const running = tools.find(t => t.textContent?.includes('Run npm test'))!;
    expect(running.querySelector('[role="status"]')).not.toBeNull();
    const done = tools.find(t => t.textContent?.includes('Read src/db.ts'))!;
    expect(done.querySelector('.ok')).not.toBeNull();
    expect(done.querySelector('[role="status"]')).toBeNull();
    // tool_start and tool_end pair into one row
    expect(tools.filter(t => t.textContent?.includes('Read src/db.ts'))).toHaveLength(1);
  });

  it('renders a change card from its facts with an exact badge; clicking selects the file', () => {
    mount();
    const card = host.querySelector('.f-chg')!;
    expect(card.textContent).toContain('Added createOrder');
    expect(card.querySelector('.ag-badge')?.textContent).toMatch(/exact/i);
    act(() => (card.querySelector('.ch') as HTMLElement).click());
    expect(useStore.getState().selected).toBe('src/orders.ts');
  });

  it('opens the inspector slide-over from a change card below 1080 px', () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('max-width:1079'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      mount();
      act(() => (host.querySelector('.f-chg .ch') as HTMLElement).click());
      expect(useStore.getState().selected).toBe('src/orders.ts');
      expect(useStore.getState().panel).toBe('inspector');
    } finally {
      window.matchMedia = real;
    }
  });

  it('makes a deleted file\'s change card non-interactive, so it never selects or joins Recent', () => {
    const gone = change('src/old.ts', 'deleted', { at: T + 6000 });
    const stale = change('src/moved.ts', 'modified', { at: T + 7000 });
    mount([created, gone, stale]);
    const cards = [...host.querySelectorAll('.f-chg')];
    const header = (p: string) => cards.find(c => c.textContent?.includes(p))!.querySelector('.ch') as HTMLButtonElement;
    expect(header('src/old.ts').disabled).toBe(true);
    expect(header('src/old.ts').title).toMatch(/deleted/);
    expect(header('src/moved.ts').disabled).toBe(true);
    expect(header('src/moved.ts').title).toMatch(/no longer/);
    act(() => header('src/old.ts').click());
    act(() => header('src/moved.ts').click());
    expect(useStore.getState().selected).toBeNull();
    expect(useStore.getState().history).toEqual([]);
    expect(header('src/orders.ts').disabled).toBe(false);
  });

  it('shows the change summary as a one-line lead above the facts, as plain text', () => {
    mount();
    expect(host.querySelector('.f-chg .lead')).toBeNull();
    act(() => useStore.getState().apply({ type: 'summary', changeId: created.id, summary: 'Adds <i>order</i> creation.' }));
    const card = host.querySelector('.f-chg')!;
    const lead = card.querySelector('.lead')!;
    expect(lead.textContent).toBe('Adds <i>order</i> creation.');
    expect(lead.querySelector('i')).toBeNull();
    expect(lead.nextElementSibling?.classList.contains('facts')).toBe(true);
  });

  it('shows a new route at its full mounted path from the domain index, else at its file path', () => {
    const route = { method: 'DELETE', path: '/orders/:id', line: 9, kind: 'api' as const, framework: 'express', handler: 'removeOrder' };
    const added = change('src/routes/orders.ts', 'modified', { at: T + 6000, routes: { added: [route, { ...route, method: 'PUT', line: 10 }], removed: [] } });
    useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [added], usedBy: [], domain: emptyDomain(), indexing: false,
      events: [], sessions: [], control: { paused: false, flags: [] },
    });
    act(() => root.render(<Activity />));
    const codes = () => [...host.querySelectorAll('.f-chg .fact')].filter(f => f.querySelector('.tg')?.textContent === 'Route').map(f => f.querySelector('code')?.textContent);
    expect(codes()).toEqual(['DELETE /orders/:id', 'PUT /orders/:id']);
    const full = { ...route, id: 'DELETE /api/orders/:id src/routes/orders.ts:9', file: 'src/routes/orders.ts', fullPath: '/api/orders/:id', mountedVia: ['src/index.ts'] };
    const elsewhere = { ...full, id: 'x', file: 'src/other.ts', fullPath: '/other/orders/:id' };
    act(() => useStore.getState().apply({ type: 'domain', domain: { ...emptyDomain(), routes: [full, elsewhere] } }));
    expect(codes()).toEqual(['DELETE /api/orders/:id', 'PUT /orders/:id']);
  });

  it('orders the feed by time, merging events and changes', () => {
    mount();
    const order = [...host.querySelectorAll('.f-prompt, .f-msg, .f-tool, .f-chg')].map(n => n.className.split(' ').find(c => c.startsWith('f-')));
    expect(order).toEqual(['f-prompt', 'f-msg', 'f-tool', 'f-chg', 'f-tool']);
  });

  it('types only messages that arrive live, never replayed ones', () => {
    mount();
    expect(host.querySelector('.f-msg')).not.toBeNull();
    expect(host.querySelector('.typing')).toBeNull();
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ id: 6, at: Date.now(), type: 'message', text: 'Done. The orders page is live.' }) }));
    expect(host.querySelectorAll('.f-msg')).toHaveLength(2);
    expect(host.querySelectorAll('.typing')).toHaveLength(1);
  });

  it('a new LiveMap run (ids restart at 1) types its messages and keeps none of the old run\'s row state', () => {
    const run = (sid: string, events: AgentEvent[]) => useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
      events, sessions: [session({ id: sid, status: 'working', startedAt: T })], control: { paused: false, flags: [] },
    });
    run('r1', [event({ id: 1, at: T, sessionId: 'r1', type: 'prompt', text: 'First run' }), event({ id: 2, at: T + 1, sessionId: 'r1', type: 'thinking', text: 'Old thought' })]);
    act(() => root.render(<Activity />));
    // Run 1: message 3 arrives live and types out; the reader opens the thinking row.
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ id: 3, at: T + 2, sessionId: 'r1', type: 'message', text: 'Run one says hi' }) }));
    expect(host.querySelectorAll('.typing')).toHaveLength(1);
    act(() => (host.querySelector('.f-think button') as HTMLElement).click());
    expect(host.querySelector('.f-think.open')).not.toBeNull();

    // LiveMap restarts: the same ids now name other events.
    act(() => run('r2', [event({ id: 1, at: T + 10, sessionId: 'r2', type: 'prompt', text: 'Second run' }), event({ id: 2, at: T + 11, sessionId: 'r2', type: 'thinking', text: 'New thought' })]));
    expect(host.querySelector('.f-prompt')?.textContent).toContain('Second run');
    expect(host.querySelector('.f-think.open')).toBeNull();
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ id: 3, at: T + 12, sessionId: 'r2', type: 'message', text: 'Run two says hi' }) }));
    expect(host.querySelectorAll('.typing')).toHaveLength(1);
  });

  it('a reconnect to the same LiveMap run keeps the feed\'s open rows', () => {
    const events = [event({ id: 1, at: T, sessionId: 'r1', type: 'prompt', text: 'First run' }), event({ id: 2, at: T + 1, sessionId: 'r1', type: 'thinking', text: 'A thought' })];
    const hello = (evs: AgentEvent[]) => useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
      events: evs, sessions: [session({ id: 'r1', status: 'working', startedAt: T })], control: { paused: false, flags: [] },
    });
    hello(events);
    act(() => root.render(<Activity />));
    act(() => (host.querySelector('.f-think button') as HTMLElement).click());
    expect(host.querySelector('.f-think.open')).not.toBeNull();
    const runs = useStore.getState().hellos;
    // The socket drops and the same run sends its hello again, with one more event.
    act(() => hello([...events, event({ id: 3, at: T + 2, sessionId: 'r1', type: 'message', text: 'More' })]));
    expect(host.querySelector('.f-think.open')).not.toBeNull();
    expect(useStore.getState().hellos).toBe(runs);
    // A new run: id 1 now names another event.
    act(() => hello([event({ id: 1, at: T + 50, sessionId: 'r2', type: 'prompt', text: 'New run' })]));
    expect(useStore.getState().hellos).toBe(runs + 1);
  });

  it('computes hero counters from change facts', () => {
    mount();
    const stats = [...host.querySelectorAll('.hero .stat')].map(s => s.textContent);
    expect(stats).toEqual(['1new files', '1functions', '0routes', '0tables']);
    expect(host.querySelector('.hero h3')?.textContent).toBe('Run npm test');
    // A message while the tool still runs does not hide it.
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ id: 7, at: Date.now(), type: 'message', text: 'Running the tests.' }) }));
    expect(host.querySelector('.hero h3')?.textContent).toBe('Run npm test');
  });

  it('keeps the first group and its expanded rows when new events shift a feed past 500 items', () => {
    const many: AgentEvent[] = [];
    for (let i = 1; i <= 600; i++) many.push(event({ id: 1000 + i, at: T + i, type: 'message', text: `step ${i}` }));
    many.push(event({ id: 1601, at: T + 601, type: 'thinking', text: 'Considering the schema' }));
    useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
      events: many, sessions: [s1], control: { paused: false, flags: [] },
    });
    act(() => root.render(<Activity />));
    expect(host.querySelectorAll('.f-msg')).toHaveLength(499);
    const turn = host.querySelector('.turn');
    act(() => (host.querySelector('.f-think button') as HTMLElement).click());
    expect(host.querySelector('.f-think.open')).not.toBeNull();
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ id: 1602, at: T + 602, type: 'message', text: 'next' }) }));
    expect(host.querySelector('.turn')).toBe(turn);
    expect(host.querySelector('.f-think.open')).not.toBeNull();
    expect(host.querySelector('.earlier')?.textContent).toContain('102 more');
  });

  const mountWith = (extra: AgentEvent[], sessions = [s1], paused = false) => {
    useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
      events: extra, sessions, control: { paused, flags: [] },
    });
    act(() => root.render(<Activity />));
  };

  it('I1: a blocked tool shows a cross, not a spinner', () => {
    mountWith([
      event({ id: 3001, at: T, type: 'tool_start', agent: 'codex', tool: { id: 'b1', name: 'apply_patch', label: 'Patch src/a.ts', paths: ['src/a.ts'] } }),
      event({ id: 3002, at: T, type: 'tool_end', agent: 'codex', tool: { id: 'b1', name: 'apply_patch', label: 'Patch src/a.ts', ok: false, output: 'Blocked by LiveMap', paths: ['src/a.ts'] } }),
    ]);
    const row = host.querySelector('.f-tool')!;
    expect(row.querySelector('.bad')).not.toBeNull();
    expect(row.querySelector('[role="status"]')).toBeNull();
  });

  it('M8: a finished tool with unknown ok shows a neutral icon, not a green check', () => {
    mountWith([
      event({ id: 3011, at: T, type: 'tool_start', agent: 'cursor', tool: { id: 'c1', name: 'Read', label: 'Read a.ts', paths: [] } }),
      event({ id: 3012, at: T + 10, type: 'tool_end', agent: 'cursor', tool: { id: 'c1', name: 'Read', label: 'Read a.ts', paths: [] } }),
    ]);
    const row = host.querySelector('.f-tool')!;
    expect(row.querySelector('.ok')).toBeNull();
    expect(row.querySelector('.bad')).toBeNull();
    expect(row.querySelector('.fin')?.getAttribute('aria-label')).toBe('Finished');
  });

  it('folds a merge commit into one compact line, and keeps real commits as cards', () => {
    mountWith([
      event({ id: 3021, at: T, type: 'commit', agent: 'git', sessionId: 'Ada', text: 'Add login form\n\nWith tests.', paths: ['a.ts'] }),
      event({ id: 3022, at: T + 10, type: 'commit', agent: 'git', sessionId: 'Ada', text: 'Merge pull request #12 from acme/login\n\nAdd login form', merge: true, paths: ['a.ts'] }),
      // Recorded before merges were flagged: known by its message.
      event({ id: 3023, at: T + 20, type: 'commit', agent: 'git', sessionId: 'Ada', text: "Merge branch 'main' into feat/x" }),
    ]);
    const rows = [...host.querySelectorAll('.f-git')];
    expect(rows).toHaveLength(3);
    expect(rows[0].classList.contains('merge')).toBe(false);
    expect(rows[0].querySelector('p')?.textContent).toBe('With tests.');
    for (const m of rows.slice(1)) {
      expect(m.classList.contains('merge')).toBe(true);
      expect(m.querySelector('p')).toBeNull();
    }
    expect(rows[1].textContent).toContain('Merge pull request #12 from acme/login');
  });

  it('keeps a merge by another author under the commits it brought in, without a header of its own', () => {
    mountWith([
      event({ id: 3031, at: T, type: 'commit', agent: 'git', sessionId: 'Ben', text: 'Add login form' }),
      event({ id: 3032, at: T + 10, type: 'commit', agent: 'git', sessionId: 'Ada', text: 'Merge pull request #12 from acme/login', merge: true }),
    ]);
    expect(host.querySelectorAll('.turn')).toHaveLength(1);
    expect(host.querySelector('.turn-h')?.textContent).toContain('Ben');
  });

  it('I3: an unhooked session is never shown paused', () => {
    mountWith([], [session({ id: 'u', hooks: false, status: 'working' })], true);
    expect(host.querySelector('.hero')?.className).not.toContain('paused');
    expect(host.querySelector('.hero .lbl')?.textContent).not.toContain('Paused');
  });

  it('restores the reader\'s scroll position when the tab is shown again', () => {
    mount();
    const el = host.querySelector<HTMLDivElement>('.actv')!;
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 300;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    act(() => root.render(<Activity active={false} />));
    // Browsers reset the scroll offset of a display:none box (and may fire scroll).
    el.scrollTop = 0;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    act(() => root.render(<Activity active />));
    expect(el.scrollTop).toBe(300);
  });
});
