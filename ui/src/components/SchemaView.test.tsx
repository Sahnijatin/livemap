// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DomainIndex, Table } from '@shared/domain.js';
import { useStore } from '../store';
import { emptyDomain } from '../fixtures';
import { LAYOUT_TIMEOUT, NODE_W, relationLinks, type ElkRun } from '../layout/schemaLayout';
import { CAP, SchemaView, pickTables } from './SchemaView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React Flow needs these browser APIs; jsdom has neither.
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;
  class DM { m22 = 1; constructor() {} }
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DM;
});

let host: HTMLDivElement;
let root: Root;

/** A layout stand-in: cards in a row, so tests do not depend on ELK. */
const rowRun: ElkRun = async g => ({ ...g, children: g.children!.map((c, i) => ({ ...c, x: i * 400, y: 0 })) });

const F = 'prisma/schema.prisma';
const user: Table = {
  name: 'User', table: 'users', orm: 'prisma', sources: [{ file: F, line: 3 }],
  fields: [
    { name: 'id', type: 'String', pk: true, required: true, line: 4, file: F },
    { name: 'email', type: 'String', unique: true, required: true, line: 5, file: F },
    { name: 'posts', type: 'Post[]', relation: { model: 'Post', many: true }, line: 6, file: F },
  ],
  relations: [{ field: 'posts', to: 'posts', many: true, via: 'relation' }],
};
const post: Table = {
  name: 'Post', table: 'posts', orm: 'prisma', sources: [{ file: F, line: 9 }, { file: 'db/migrations/002.sql', line: 1 }],
  fields: [
    { name: 'id', type: 'String', pk: true, required: true, line: 10, file: F },
    { name: 'authorId', type: 'String', required: true, fk: { table: 'users', field: 'id' }, line: 11, file: F },
    { name: 'author', type: 'User', relation: { model: 'User', many: false }, line: 12, file: F },
    { name: 'status', type: 'text', line: 2, file: 'db/migrations/002.sql' },
  ],
  relations: [
    { field: 'authorId', to: 'users', many: false, via: 'fk' },
    { field: 'author', to: 'users', many: false, via: 'relation' },
  ],
};

const domainOf = (tables: Table[]): DomainIndex => {
  const d = emptyDomain();
  d.tables = tables;
  d.counts.tables = tables.length;
  return d;
};

async function mount(tables: Table[], run: ElkRun = rowRun) {
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: domainOf(tables), indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] },
  });
  await act(async () => root.render(<SchemaView run={run} />));
  await settleLayout();
}

/** Let layout promises settle and the nodes render. */
async function settleLayout() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function update(tables: Table[]) {
  await act(async () => useStore.getState().apply({ type: 'domain', domain: domainOf(tables) }));
  await settleLayout();
}

/** A bare table with a unique key, so positions remembered by earlier tests do not apply. */
const bare = (name: string): Table => ({ ...user, name, table: name.toLowerCase(), fields: [user.fields[0]], relations: [] });

/** A card's position on the canvas, read from React Flow's node wrapper. */
function posOf(key: string): { x: number; y: number } | null {
  const el = host.querySelector<HTMLElement>(`.react-flow__node[data-id="${key}"]`);
  const m = el && /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

const card = (name: string) => [...host.querySelectorAll<HTMLElement>('.tbl')].find(t => t.querySelector('.tn')?.textContent === name)!;

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

describe('SchemaView', () => {
  it('shows table cards with the name, ORM badge, PK and FK markers', async () => {
    await mount([user, post]);
    const p = card('Post');
    expect(p).toBeTruthy();
    expect(p.querySelector('.orm')?.textContent).toBe('Prisma');
    expect(p.querySelector('.tt')?.textContent).toBe('posts');
    const rows = [...p.querySelectorAll('.col')].map(r => r.querySelector('.mk')?.textContent);
    expect(rows).toEqual(['PK', 'FK', '', '']);
    expect(card('User').querySelector('.col:nth-child(2) .mk')?.textContent).toBe('UQ');
  });

  it('clicking a table header selects its first source file at its line; a field row reveals its own line', async () => {
    await mount([user, post]);
    act(() => card('Post').querySelector<HTMLButtonElement>('.th')!.click());
    expect(useStore.getState().selected).toBe(F);
    expect(useStore.getState().reveal).toMatchObject({ path: F, line: 9 });
    const status = [...card('Post').querySelectorAll<HTMLButtonElement>('.col')].find(r => r.textContent?.includes('status'))!;
    act(() => status.click());
    expect(useStore.getState().reveal).toMatchObject({ path: 'db/migrations/002.sql', line: 2 });
  });

  it('marks tables and fields added after hello', async () => {
    await mount([user]);
    const grown = { ...user, fields: [...user.fields, { name: 'name', type: 'String', line: 7, file: F }] };
    await act(async () => useStore.getState().apply({ type: 'domain', domain: domainOf([grown, post]) }));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(card('Post').classList.contains('isnew')).toBe(true);
    expect(card('Post').querySelector('.newtag')?.textContent).toBe('NEW');
    expect(card('User').classList.contains('isnew')).toBe(false);
    const rows = [...card('User').querySelectorAll('.col')];
    expect(rows.filter(r => r.classList.contains('new')).map(r => r.querySelector('.cn')?.textContent)).toEqual(['name']);
  });

  it('shows 12 fields and a "+N more" row that expands', async () => {
    const wide: Table = { ...user, fields: Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, type: 'int', file: F })), relations: [] };
    await mount([wide]);
    const more = card('User').querySelector<HTMLButtonElement>('.col.more')!;
    expect(more.textContent).toBe('+3 more');
    expect(card('User').querySelectorAll('.col:not(.more)').length).toBe(12);
    await act(async () => more.click());
    expect(card('User').querySelectorAll('.col:not(.more)').length).toBe(15);
  });

  it('shows the hint with the number of source files', async () => {
    await mount([user, post]);
    expect(host.querySelector('.cv-hint')?.textContent).toBe('Tables and relations, read from 2 files. Links are approximate.');
  });

  it('shows the empty state when there are no tables', async () => {
    await mount([]);
    expect(host.textContent).toContain('No tables yet.');
    expect(host.textContent).toContain('LiveMap reads Prisma, Drizzle, TypeORM, Mongoose, SQLAlchemy, SQLModel, Django, Room, SwiftData and SQL migrations.');
  });

  it('over 150 tables draws the 150 with the most relations and offers "Show all"', async () => {
    const many: Table[] = Array.from({ length: 160 }, (_, i) => ({ ...user, name: `T${i}`, table: `t${i}`, fields: [user.fields[0]], relations: [] }));
    // T159 is linked from T158, so both rank above the unlinked tables.
    many[158] = { ...many[158], relations: [{ field: 'id', to: 't159', many: false, via: 'fk' }] };
    await mount(many);
    expect(host.querySelectorAll('.tbl').length).toBe(CAP);
    expect(card('T159')).toBeTruthy();
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Show all 160');
    expect(btn).toBeTruthy();
  });
});

describe('SchemaView layout robustness', () => {
  afterEach(() => vi.useRealTimers());

  it('a layout that rejects (worker failed) still draws the cards, in a grid', async () => {
    await mount([bare('Rej1'), bare('Rej2')], () => Promise.reject(new Error('worker failed')));
    expect(card('Rej1')).toBeTruthy();
    expect(card('Rej2')).toBeTruthy();
    expect(posOf('rej1')).not.toEqual(posOf('rej2'));
  });

  it('a layout that never settles falls back to the grid after 10 s', async () => {
    vi.useFakeTimers();
    useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: domainOf([bare('Hang1')]), indexing: false,
      events: [], sessions: [], control: { paused: false, flags: [] },
    });
    await act(async () => root.render(<SchemaView run={() => new Promise(() => {})} />));
    expect(card('Hang1')).toBeFalsy();
    await act(async () => { await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT); });
    expect(card('Hang1')).toBeTruthy();
  });

  it('discards a layout that resolves after a newer one started', async () => {
    const calls: { graph: Parameters<ElkRun>[0]; resolve: (x: number) => void }[] = [];
    const deferred: ElkRun = g => new Promise(res => {
      calls.push({ graph: g, resolve: x => res({ ...g, children: g.children!.map(c => ({ ...c, x, y: 0 })) }) });
    });
    await mount([bare('RaceA')], deferred);
    act(() => calls[0].resolve(0));
    await settleLayout();
    await update([bare('RaceA'), bare('RaceB')]);
    await update([bare('RaceA'), bare('RaceB'), bare('RaceC')]);
    expect(calls).toHaveLength(3);
    // The newest layout lands first; the older one arrives late and must be ignored.
    await act(async () => calls[2].resolve(2000));
    await settleLayout();
    await act(async () => calls[1].resolve(9000));
    await settleLayout();
    expect(posOf('raceb')?.x).not.toBe(9000);
    expect(posOf('racec')).toBeTruthy();
  });

  it('forgets a removed table, so when it returns it does not land on a newcomer in its old spot', async () => {
    await mount([bare('Keep'), bare('Gone')]);
    const old = posOf('gone')!;
    await update([bare('Keep')]);
    await update([bare('Keep'), bare('Newer')]);
    expect(posOf('newer')).toEqual(old);
    await update([bare('Keep'), bare('Newer'), bare('Gone')]);
    // Placed as a new table (third in the row layout), and the newcomer stays put.
    expect(posOf('newer')).toEqual(old);
    expect(posOf('gone')).toEqual({ x: 800, y: 0 });
  });

  it('hover marks the card and its neighbors through the wrapper class only', async () => {
    const a = { ...bare('HovA'), fields: [user.fields[0], { name: 'bId', type: 'String', fk: { table: 'hovb', field: 'id' }, file: F }], relations: [{ field: 'bId', to: 'hovb', many: false, via: 'fk' as const }] };
    await mount([a, bare('HovB'), bare('HovC')]);
    const wrap = (k: string) => host.querySelector<HTMLElement>(`.react-flow__node[data-id="${k}"]`)!;
    const tbl = wrap('hova').querySelector('.tbl');
    await act(async () => { wrap('hova').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    expect(wrap('hova').classList.contains('hl')).toBe(true);
    expect(wrap('hovb').classList.contains('hl')).toBe(true);
    expect(wrap('hovc').classList.contains('dim')).toBe(true);
    // The card itself was not rebuilt.
    expect(wrap('hova').querySelector('.tbl')).toBe(tbl);
    expect(tbl?.classList.contains('hl')).toBe(false);
  });
});

describe('pickTables', () => {
  it('keeps every table up to the cap, and the most related ones beyond it', () => {
    const t = (i: number, rel: string[] = []): Table => ({ ...user, table: `t${i}`, relations: rel.map(to => ({ field: 'x', to, many: false, via: 'fk' })) });
    const list = Array.from({ length: CAP + 2 }, (_, i) => t(i));
    list[CAP + 1] = t(CAP + 1, ['t0']);
    expect(pickTables(list.slice(0, CAP), false)).toHaveLength(CAP);
    const picked = pickTables(list, false).map(x => x.table);
    expect(picked).toHaveLength(CAP);
    expect(picked).toContain(`t${CAP + 1}`);
    expect(picked).toContain('t0');
    expect(pickTables(list, true)).toHaveLength(CAP + 2);
  });
});

describe('relationLinks', () => {
  it('draws one link per Prisma relationship: the foreign key, not the relation field or the list back-reference', () => {
    expect(relationLinks([user, post]).map(l => [l.from, l.field, l.to, l.many])).toEqual([['posts', 'authorId', 'users', false]]);
  });

  it('draws a one-to-one once, from the side that holds the foreign key', () => {
    const u = { ...user, relations: [{ field: 'profile', to: 'profiles', many: false, via: 'relation' as const }] };
    const profile: Table = { ...post, name: 'Profile', table: 'profiles', relations: [{ field: 'userId', to: 'users', many: false, via: 'fk' }] };
    expect(relationLinks([u, profile]).map(l => [l.from, l.field, l.to])).toEqual([['profiles', 'userId', 'users']]);
  });

  it('keeps a list relation with no link back, and omits links to tables that are not drawn', () => {
    const lonely = { ...user, relations: [{ field: 'posts', to: 'posts', many: true, via: 'relation' as const }, { field: 'x', to: 'nowhere', many: false, via: 'fk' as const }] };
    const bare = { ...post, relations: [] };
    expect(relationLinks([lonely, bare]).map(l => [l.from, l.to, l.many])).toEqual([['users', 'posts', true]]);
  });
});

describe('SchemaView palette focus (tableFocus)', () => {
  const reduced = () => vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  const wrap = (k: string) => host.querySelector<HTMLElement>(`.react-flow__node[data-id="${k}"]`);
  /** The card's horizontal center on screen relative to the canvas center (React Flow's unmeasured canvas is 500 wide in jsdom). */
  const centerX = (k: string) => {
    const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(host.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform)!;
    return (posOf(k)!.x + NODE_W / 2) * Number(m[3]) + Number(m[1]) - 250;
  };
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('centers the table and highlights it briefly', async () => {
    reduced();
    await mount([bare('FocA'), bare('FocB'), bare('FocC')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => useStore.getState().focusTable('focc'));
    expect(Math.abs(centerX('focc'))).toBeLessThan(1);
    expect(wrap('focc')!.classList.contains('pulse')).toBe(true);
    expect(wrap('foca')!.classList.contains('pulse')).toBe(false);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(wrap('focc')!.classList.contains('pulse')).toBe(false);
  });

  it('a table beyond the cap turns on "Show all" first, then is focused', async () => {
    reduced();
    const many: Table[] = Array.from({ length: CAP + 5 }, (_, i) => ({ ...user, name: `Cap${i}`, table: `cap${i}`, fields: [user.fields[0]], relations: [] }));
    await mount(many);
    expect(wrap(`cap${CAP + 4}`)).toBeNull();
    await act(async () => useStore.getState().focusTable(`cap${CAP + 4}`));
    await settleLayout();
    await settleLayout();
    expect(wrap(`cap${CAP + 4}`)).not.toBeNull();
    expect(wrap(`cap${CAP + 4}`)!.classList.contains('pulse')).toBe(true);
    expect(Math.abs(centerX(`cap${CAP + 4}`))).toBeLessThan(1);
  });
});
