// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DomainIndex, Table } from '@shared/domain.js';
import { useStore } from '../store';
import { emptyDomain } from '../fixtures';
import { CenterTabs } from './CenterTabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const table = (name: string): Table => ({ name, table: name, orm: 'prisma', sources: [{ file: 'prisma/schema.prisma', line: 1 }], fields: [], relations: [] });
const withTables = (n: number): DomainIndex => {
  const d = emptyDomain();
  d.tables = Array.from({ length: n }, (_, i) => table(`T${i}`));
  d.counts.tables = n;
  d.counts.routes = 2;
  d.counts.pages = 1;
  return d;
};

function mount(domain = withTables(2)) {
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain, indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] },
  });
  act(() => root.render(<CenterTabs />));
}

const tab = (name: string) => host.querySelector<HTMLButtonElement>(`[role=tab][data-tab="${name}"]`)!;

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

describe('CenterTabs', () => {
  it('renders a tablist with Activity, Schema, API and Stack and no Map tab', () => {
    mount();
    const tabs = [...host.querySelectorAll('[role=tablist] [role=tab]')].map(t => t.getAttribute('aria-label'));
    expect(tabs).toEqual(['Activity', 'Schema, 2', 'API, 3', 'Stack']);
    expect(tab('activity').getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(tab('activity').id);
  });

  it('clicking Schema sets the tab', () => {
    mount();
    act(() => tab('schema').click());
    expect(useStore.getState().tab).toBe('schema');
    expect(tab('schema').getAttribute('aria-selected')).toBe('true');
    expect(tab('activity').getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowRight moves focus and selection; ArrowLeft wraps; tabindex roves', () => {
    mount();
    tab('activity').focus();
    act(() => { tab('activity').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(useStore.getState().tab).toBe('schema');
    expect(document.activeElement).toBe(tab('schema'));
    expect(tab('schema').tabIndex).toBe(0);
    expect(tab('activity').tabIndex).toBe(-1);
    act(() => { tab('schema').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    act(() => { tab('activity').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(useStore.getState().tab).toBe('stack');
    expect(document.activeElement).toBe(tab('stack'));
  });

  it('badges show tables and routes + pages + screens; the schema badge bumps when the count increases', () => {
    mount();
    const badge = () => tab('schema').querySelector('.cnt')!;
    expect(badge().textContent).toBe('2');
    expect(tab('api').querySelector('.cnt')!.textContent).toBe('3');
    expect(tab('stack').querySelector('.cnt')).toBeNull();
    expect(badge().classList.contains('bump')).toBe(false);
    act(() => useStore.getState().apply({ type: 'domain', domain: withTables(3) }));
    expect(badge().textContent).toBe('3');
    expect(badge().classList.contains('bump')).toBe(true);
    // A drop before the bump ends clears it instead of leaving it stuck.
    act(() => useStore.getState().apply({ type: 'domain', domain: withTables(1) }));
    expect(badge().classList.contains('bump')).toBe(false);
  });

  it('shows the Stack view on the Stack tab', () => {
    mount();
    act(() => tab('stack').click());
    expect(host.querySelector('.stackv')).not.toBeNull();
  });
});
