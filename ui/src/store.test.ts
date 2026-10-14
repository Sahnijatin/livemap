import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, MAX_CHANGES } from './store';
import { file, change } from './fixtures';

const hello = (files = [file('a.ts'), file('b.ts'), file('c.ts')]) => ({
  type: 'hello' as const, root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], indexing: false,
});

beforeEach(() => useStore.getState().reset());

describe('store.apply', () => {
  it('hello replaces everything; files upserts and removes', () => {
    const s = useStore.getState();
    s.apply({ type: 'hello', root: '/old', name: 'old', files: [file('zzz.ts')], changes: [change('zzz.ts')], usedBy: [{ file: 'zzz.ts', symbol: 'x', usedIn: [] }], indexing: false });
    s.apply(hello());
    let st = useStore.getState();
    expect(st.name).toBe('shop');
    expect(st.root).toBe('/p/shop');
    expect(Object.keys(st.files).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(st.changes).toEqual([]);
    expect(st.usedBy).toEqual([]);
    const c = st.files['c.ts'];

    const f2 = file('b.ts', [], { lines: 99 });
    s.apply({ type: 'files', files: [f2], removed: ['a.ts'] });
    st = useStore.getState();
    expect(Object.keys(st.files).sort()).toEqual(['b.ts', 'c.ts']);
    expect(st.files['b.ts']).toBe(f2);
    expect(st.files['c.ts']).toBe(c);
  });

  it('a change applies its file updates in the same state update', () => {
    const s = useStore.getState();
    s.apply(hello());
    const f2 = file('b.ts', [], { lines: 7 });
    let updates = 0;
    const unsub = useStore.subscribe(() => { updates++; });
    s.apply({ type: 'change', change: change('b.ts', 'modified'), files: [f2], removed: ['a.ts'] });
    unsub();
    expect(updates).toBe(1);
    const st = useStore.getState();
    expect(st.files['b.ts']).toBe(f2);
    expect(st.files['a.ts']).toBeUndefined();
    expect(st.recent['b.ts'].kind).toBe('modified');
  });

  it('change records recent kind, auto-expands the file and keeps the last 2,000 changes', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'created') });
    let st = useStore.getState();
    expect(st.recent['a.ts'].kind).toBe('created');
    expect(st.expanded['a.ts']).toBe(true);
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'modified') });
    expect(useStore.getState().recent['a.ts'].kind).toBe('modified');

    s.apply(hello());
    for (let i = 0; i < 2001; i++) s.apply({ type: 'change', files: [], removed: [], change: change(`f${i}.ts`) });
    st = useStore.getState();
    expect(MAX_CHANGES).toBe(2000);
    expect(st.changes).toHaveLength(2000);
    expect(st.changes[0].path).toBe('f1.ts');
    expect(st.changes[1999].path).toBe('f2000.ts');
  });

  it('a deleted change removes recent[path]; a removed selected path resets selected on the next files message', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'modified') });
    s.select('a.ts');
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'deleted') });
    let st = useStore.getState();
    expect(st.recent['a.ts']).toBeUndefined();
    expect(st.selected).toBe('a.ts');
    s.apply({ type: 'files', files: [], removed: ['a.ts'] });
    st = useStore.getState();
    expect(st.selected).toBeNull();
  });

  it('usedBy replaces; indexing records progress until hello', () => {
    const s = useStore.getState();
    s.apply({ type: 'indexing', done: 3, total: 10 });
    expect(useStore.getState().indexing).toEqual({ done: 3, total: 10 });
    s.apply(hello());
    expect(useStore.getState().indexing).toBeNull();
    s.apply({ type: 'usedBy', usedBy: [{ file: 'a.ts', symbol: 'a', usedIn: ['b.ts'] }] });
    s.apply({ type: 'usedBy', usedBy: [{ file: 'b.ts', symbol: 'b', usedIn: ['c.ts'] }] });
    expect(useStore.getState().usedBy).toEqual([{ file: 'b.ts', symbol: 'b', usedIn: ['c.ts'] }]);
  });

  it('toggle flips expansion and setFilter stores the query', () => {
    const s = useStore.getState();
    s.toggle('a.ts');
    expect(useStore.getState().expanded['a.ts']).toBe(true);
    s.toggle('a.ts');
    expect(useStore.getState().expanded['a.ts']).toBe(false);
    s.setFilter('order');
    expect(useStore.getState().filter).toBe('order');
  });
});
