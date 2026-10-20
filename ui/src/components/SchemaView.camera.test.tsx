// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Table } from '@shared/domain.js';
import type { ElkRun } from '../layout/elk';

/*
 * The focus camera on a pane with no size yet (the fallback that centers the table): it waits for a first fit still
 * queued in React Flow, like the sized path, so the fit never lands on top of it. React Flow's fitView is wrapped to
 * hold its promise until the test lets it go, and setCenter to record when it runs.
 */

const calls: string[] = [];
let release: () => void = () => {};
const gate = () => new Promise<void>(r => { release = r; });

vi.mock('@xyflow/react', async orig => {
  const m = await orig<typeof import('@xyflow/react')>();
  const wrapped = new WeakMap<object, object>();
  return {
    ...m,
    useReactFlow: () => {
      const rf = m.useReactFlow() as unknown as Record<string, (...a: unknown[]) => unknown>;
      let w = wrapped.get(rf);
      if (!w) {
        w = new Proxy(rf, {
          get(t, k: string) {
            // The fit counts as applied when the test releases it (React Flow's own promise settles on a later node update).
            if (k === 'fitView') return (...a: unknown[]) => { calls.push('fit'); return gate().then(() => { calls.push('fit done'); void Promise.resolve(t.fitView(...a)).catch(() => {}); }); };
            if (k === 'setCenter') return (...a: unknown[]) => { calls.push('center'); return t.setCenter(...a); };
            return t[k];
          },
        });
        wrapped.set(rf, w);
      }
      return w;
    },
  };
});

const { useStore } = await import('../store');
const { SchemaView } = await import('./SchemaView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React Flow needs these browser APIs; jsdom has neither. Here nodes also get a size, so React Flow counts them as
// measured and the view issues its first fit (a ResizeObserver that reports each element when observed).
beforeAll(() => {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) { queueMicrotask(() => this.cb([{ target: el, contentRect: { width: 280, height: 120 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)); }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
  class DM { m22 = 1; constructor() {} }
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DM;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 120 });
});

let host: HTMLDivElement;
let root: Root;
afterEach(() => { act(() => root.unmount()); host.remove(); calls.length = 0; });

const F = 'prisma/schema.prisma';
const table = (name: string): Table => ({
  name, table: name.toLowerCase(), orm: 'prisma', sources: [{ file: F, line: 1 }],
  fields: [{ name: 'id', type: 'Int', pk: true, required: true, line: 2, file: F }], relations: [],
});
/** A layout stand-in: cards in a row. */
const rowRun: ElkRun = async g => ({ ...g, children: g.children!.map((c, i) => ({ ...c, x: i * 400, y: 0 })) });

describe('SchemaView focus camera without a pane size', () => {
  it('centers the focused table only after a first fit still in flight', async () => {
    const tables = [table('Alpha'), table('Beta'), table('Gamma')];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.getState().reset();
    useStore.getState().apply({ type: 'hello', root: '/p', name: 'p', files: [], changes: [], usedBy: [], indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
      domain: { routes: [], tables, dataRefs: [], stack: [], deps: [], scripts: [], env: [], counts: { routes: 0, pages: 0, screens: 0, tables: 3, deps: 0, env: 0 } } });
    await act(async () => root.render(<SchemaView run={rowRun} />));
    for (let i = 0; i < 20 && !calls.includes('fit'); i++) await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(calls).toContain('fit');
    await act(async () => useStore.getState().focusTable('beta'));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(calls).not.toContain('center');
    await act(async () => { release(); await new Promise(r => setTimeout(r, 20)); });
    expect(calls.indexOf('center')).toBeGreaterThan(calls.indexOf('fit done'));
  });
});
