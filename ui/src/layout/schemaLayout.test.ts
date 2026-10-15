import { describe, it, expect, vi, afterEach } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Table } from '@shared/domain.js';
import { elkGraph, layoutDirection, layoutTables, nodeHeight, settle, tableKey, workerRun, LAYOUT_TIMEOUT, NARROW_PANE, NODE_W, type ElkRun, type Pos } from './schemaLayout';

const elk = new ELK();
const run: ElkRun = g => elk.layout(g);

function table(name: string, fields = 3, rel: { field: string; to: string; many?: boolean }[] = []): Table {
  return {
    name, table: name.toLowerCase(), orm: 'prisma',
    sources: [{ file: 'prisma/schema.prisma', line: 1 }],
    fields: [
      { name: 'id', type: 'String', pk: true, file: 'prisma/schema.prisma' },
      ...Array.from({ length: Math.max(0, fields - 1) }, (_, i) => ({ name: `f${i}`, type: 'String', file: 'prisma/schema.prisma' })),
      ...rel.map(r => ({ name: r.field, type: 'String', fk: { table: r.to, field: 'id' }, file: 'prisma/schema.prisma' })),
    ],
    relations: rel.map(r => ({ field: r.field, to: r.to, many: !!r.many, via: 'fk' as const })),
  };
}

function box(t: Table, p: Pos) {
  return { x: p.x, y: p.y, w: NODE_W, h: nodeHeight(t) };
}
const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function expectNoOverlap(tables: Table[], pos: Map<string, Pos>) {
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = box(tables[i], pos.get(tableKey(tables[i]))!);
      const b = box(tables[j], pos.get(tableKey(tables[j]))!);
      expect(overlaps(a, b), `${tables[i].name} overlaps ${tables[j].name}`).toBe(false);
    }
  }
}

describe('nodeHeight', () => {
  it('is the 44 px header plus 26 px per field, capped at 12 fields plus a "+N more" row', () => {
    expect(nodeHeight(table('A', 3))).toBe(44 + 3 * 26);
    expect(nodeHeight(table('A', 12))).toBe(44 + 12 * 26);
    expect(nodeHeight(table('A', 30))).toBe(44 + 13 * 26);
  });
});

describe('layoutDirection', () => {
  it('runs down a pane taller than it is wide (the desktop center pane) and across a wide one', () => {
    expect(layoutDirection(490, 1000)).toBe('DOWN');
    expect(layoutDirection(1200, 700)).toBe('RIGHT');
  });

  it('always runs down a narrow pane, even a landscape one (phones)', () => {
    expect(layoutDirection(390, 700)).toBe('DOWN');
    expect(layoutDirection(NARROW_PANE - 1, 300)).toBe('DOWN');
    expect(layoutDirection(NARROW_PANE + 200, 300)).toBe('RIGHT');
  });

  it('keeps the current direction for an unmeasured pane', () => {
    expect(layoutDirection(0, 0)).toBe('RIGHT');
    expect(layoutDirection(0, 0, 'DOWN')).toBe('DOWN');
  });

  it('does not turn for a pane near square (hysteresis)', () => {
    expect(layoutDirection(1000, 1050, 'RIGHT')).toBe('RIGHT');
    expect(layoutDirection(1050, 1000, 'DOWN')).toBe('DOWN');
    expect(layoutDirection(1000, 1300, 'RIGHT')).toBe('DOWN');
    expect(layoutDirection(1300, 1000, 'DOWN')).toBe('RIGHT');
  });
});

describe('elkGraph direction', () => {
  it('passes the direction to ELK, packing groups wide for RIGHT and tall for DOWN', () => {
    const t = [table('A')];
    expect(elkGraph(t).layoutOptions?.['elk.direction']).toBe('RIGHT');
    expect(elkGraph(t, 'DOWN').layoutOptions?.['elk.direction']).toBe('DOWN');
    expect(Number(elkGraph(t, 'DOWN').layoutOptions?.['elk.aspectRatio'])).toBeLessThan(1);
    expect(Number(elkGraph(t, 'RIGHT').layoutOptions?.['elk.aspectRatio'])).toBeGreaterThan(1);
  });

  it('puts parents above their children going DOWN, left of them going RIGHT', async () => {
    const tables = [table('User', 4), table('Post', 5, [{ field: 'authorId', to: 'user' }])];
    const down = await layoutTables(tables, new Map(), run, 'DOWN');
    expect(down.get('post')!.y).toBeGreaterThan(down.get('user')!.y);
    expect(down.get('post')!.x).toBeLessThan(down.get('user')!.x + NODE_W);
    expectNoOverlap(tables, down);
    const right = await layoutTables(tables, new Map(), run, 'RIGHT');
    expect(right.get('post')!.x).toBeGreaterThan(right.get('user')!.x);
  });
});

describe('layoutTables', () => {
  const three = () => [
    table('User', 4),
    table('Post', 5, [{ field: 'authorId', to: 'user' }]),
    table('Comment', 3, [{ field: 'postId', to: 'post' }]),
  ];

  it('gives 3 related tables distinct, non-overlapping positions', async () => {
    const tables = three();
    const pos = await layoutTables(tables, new Map(), run);
    expect(pos.size).toBe(3);
    const keys = new Set([...pos.values()].map(p => `${p.x},${p.y}`));
    expect(keys.size).toBe(3);
    expectNoOverlap(tables, pos);
  });

  it('keeps existing positions exactly and places a new table without overlap', async () => {
    const tables = three();
    const first = await layoutTables(tables, new Map(), run);
    const next = [...tables, table('Like', 3, [{ field: 'postId', to: 'post' }, { field: 'userId', to: 'user' }])];
    const second = await layoutTables(next, first, run);
    for (const t of tables) expect(second.get(tableKey(t))).toEqual(first.get(tableKey(t)));
    expect(second.has('like')).toBe(true);
    expectNoOverlap(next, second);
  });

  it('shifts a new table down in 24 px steps when its ELK box is taken', async () => {
    const tables = [table('A', 2), table('B', 2)];
    // Every node lands at the origin; A is already there, so B must move down past it.
    const stub: ElkRun = async g => ({ ...g, children: g.children!.map(c => ({ ...c, x: 0, y: 0 })) });
    const prev = new Map<string, Pos>([['a', { x: 0, y: 0 }]]);
    const pos = await layoutTables(tables, prev, stub);
    expect(pos.get('a')).toEqual({ x: 0, y: 0 });
    const b = pos.get('b')!;
    expect(b.x).toBe(0);
    expect(b.y % 24).toBe(0);
    // Free means clear of A plus the 24 px gap; one step less would still touch it.
    expect(b.y).toBeGreaterThanOrEqual(nodeHeight(tables[0]) + 24);
    expect(b.y - 24).toBeLessThan(nodeHeight(tables[0]) + 24);
  });

  it('does not run ELK when every table already has a position, and drops tables that are gone', async () => {
    const tables = [table('A')];
    let calls = 0;
    const counting: ElkRun = async g => { calls++; return run(g); };
    const prev = new Map<string, Pos>([['a', { x: 5, y: 7 }], ['gone', { x: 0, y: 0 }]]);
    const pos = await layoutTables(tables, prev, counting);
    expect(calls).toBe(0);
    expect([...pos]).toEqual([['a', { x: 5, y: 7 }]]);
  });

  it('ignores relations to tables that are not in the list', async () => {
    const tables = [table('A', 2, [{ field: 'xId', to: 'missing' }])];
    const pos = await layoutTables(tables, new Map(), run);
    expect(pos.has('a')).toBe(true);
  });

  it('lays out 150 tables in under 3 s', async () => {
    const tables = Array.from({ length: 150 }, (_, i) =>
      table(`T${i}`, 3 + (i % 10), i > 0 ? [{ field: 'parentId', to: `t${Math.floor(i / 3)}` }, { field: 'ownerId', to: `t${(i * 7) % i}` }] : []));
    const t0 = performance.now();
    const pos = await layoutTables(tables, new Map(), run);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(pos.size).toBe(150);
    expectNoOverlap(tables, pos);
  });
});

describe('settle (cards that grew)', () => {
  it('pushes down, in 24 px steps, only a card that a taller card above now overlaps', () => {
    const a = table('A', 3);
    const b = table('B', 2);
    const c = table('C', 2);
    const gap = 44;
    const prev = new Map<string, Pos>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0, y: nodeHeight(a) + gap }],
      ['c', { x: NODE_W + 104, y: 0 }],
    ]);
    // A gains 4 fields (104 px), so it now reaches into B.
    const grown = table('A', 7);
    const out = settle([grown, b, c], prev);
    expect(out.get('a')).toBe(prev.get('a'));
    expect(out.get('c')).toBe(prev.get('c'));
    const by = out.get('b')!.y;
    expect(out.get('b')!.x).toBe(0);
    expect((by - prev.get('b')!.y) % 24).toBe(0);
    expect(by).toBeGreaterThanOrEqual(nodeHeight(grown) + 24);
    expect(by - 24).toBeLessThan(nodeHeight(grown) + 24);
  });

  it('leaves every card in place when nothing overlaps, and layoutTables applies it without ELK', async () => {
    const tables = [table('A', 3), table('B', 2)];
    const prev = new Map<string, Pos>([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 400 }]]);
    const out = await layoutTables(tables, prev, () => { throw new Error('ELK must not run'); });
    expect(out.get('a')).toBe(prev.get('a'));
    expect(out.get('b')).toBe(prev.get('b'));
  });
});

describe('layout failures', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a layout that never settles rejects after 10 s', async () => {
    vi.useFakeTimers();
    const never: ElkRun = () => new Promise(() => {});
    const p = layoutTables([table('A')], new Map(), never);
    const caught = p.catch(e => e as Error);
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT);
    expect(((await caught) as Error).message).toMatch(/timed out/);
  });

  /** A Worker stand-in: `mode` decides whether it errors on the first message or never answers. */
  function stubWorker(mode: 'error' | 'hang') {
    const made: { terminated: boolean }[] = [];
    class FakeWorker extends EventTarget {
      terminated = false;
      onmessage: ((e: unknown) => void) | null = null;
      constructor() { super(); made.push(this); }
      postMessage(msg: { cmd: string }) {
        if (mode === 'error' && msg.cmd === 'layout') queueMicrotask(() => this.dispatchEvent(new Event('error', { cancelable: true })));
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeWorker);
    return made;
  }

  it('a worker error rejects the call in flight, terminates the worker and starts a fresh one next time', async () => {
    const made = stubWorker('error');
    const g = { id: 'root', children: [] };
    await expect(workerRun(g)).rejects.toThrow(/worker failed/);
    expect(made).toHaveLength(1);
    expect(made[0].terminated).toBe(true);
    await expect(workerRun(g)).rejects.toThrow(/worker failed/);
    expect(made).toHaveLength(2);
  });

  it('a worker that never answers times out, is terminated and replaced', async () => {
    const made = stubWorker('hang');
    vi.useFakeTimers();
    const g = { id: 'root', children: [] };
    const first = workerRun(g).catch(e => e as Error);
    // The worker starts after elk-api is imported; only then is the 10 s timer armed.
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT);
    expect(((await first) as Error).message).toMatch(/timed out/);
    expect(made[0].terminated).toBe(true);
    const second = workerRun(g).catch(e => e as Error);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT);
    await second;
    expect(made).toHaveLength(2);
  });

  it('concurrent first layouts share one worker start', async () => {
    const made = stubWorker('hang');
    vi.useFakeTimers();
    const g = { id: 'root', children: [] };
    const runs = [workerRun(g), workerRun(g)].map(p => p.catch(e => e as Error));
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT);
    for (const r of await Promise.all(runs)) expect((r as Error).message).toMatch(/timed out/);
    expect(made).toHaveLength(1);
  });
});
