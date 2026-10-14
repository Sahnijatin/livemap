// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DomainIndex, Table } from '@shared/domain.js';
import type { FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { emptyDomain, file } from '../fixtures';
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

const codeFiles = (): FileModel[] => [file('src/a.ts'), file('src/b.ts'), file('README.md', [], { lang: 'markdown' })];

function mount(domain = withTables(2), files: FileModel[] = codeFiles()) {
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], domain, indexing: false,
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
  it('renders a tablist with Activity, Map, Schema, API and Stack; the Map badge counts code files', () => {
    mount();
    const tabs = [...host.querySelectorAll('[role=tablist] [role=tab]')].map(t => t.getAttribute('aria-label'));
    expect(tabs).toEqual(['Activity', 'Map, 2', 'Schema, 2', 'API, 3', 'Stack']);
    expect(tab('map').querySelector('.cnt')!.textContent).toBe('2');
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
    expect(useStore.getState().tab).toBe('map');
    expect(document.activeElement).toBe(tab('map'));
    expect(tab('map').tabIndex).toBe(0);
    expect(tab('activity').tabIndex).toBe(-1);
    act(() => { tab('map').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
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

  it('shows the map tools slot only on the Map tab', () => {
    mount();
    expect(host.querySelector('.c-head .c-tools')).toBeNull();
    act(() => tab('map').click());
    expect(useStore.getState().tab).toBe('map');
    expect(host.querySelector('.c-head .c-tools')).not.toBeNull();
    act(() => tab('stack').click());
    expect(host.querySelector('.c-head .c-tools')).toBeNull();
  });

  it('shows the Stack view on the Stack tab', () => {
    mount();
    act(() => tab('stack').click());
    expect(host.querySelector('.stackv')).not.toBeNull();
  });
});

describe('CenterTabs transitions', () => {
  const views = () => [...host.querySelectorAll<HTMLElement>('.c-view')].filter(v => !v.hidden);
  const live = () => views().filter(v => !v.hasAttribute('inert'));
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('switching tabs renders the new panel at once and removes the old one after its exit', () => {
    mount();
    act(() => tab('stack').click());
    // Both are on screen during the cross-fade, but only the new one is reachable.
    expect(views()).toHaveLength(2);
    expect(live()).toHaveLength(1);
    expect(live()[0].querySelector('.stackv')).not.toBeNull();
    const old = views().find(v => v.hasAttribute('inert'))!;
    expect(old.classList.contains('leave')).toBe(true);
    expect(old.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(tab('stack').id);

    act(() => { vi.advanceTimersByTime(250); });
    expect(views()).toHaveLength(1);
    expect(views()[0].querySelector('.stackv')).not.toBeNull();
    expect(host.querySelector('.leave')).toBeNull();
    // Activity stays mounted (hidden) so its scroll position survives.
    expect(host.querySelector('.actv')).not.toBeNull();

    act(() => tab('activity').click());
    expect(live()).toHaveLength(1);
    expect(live()[0].querySelector('.actv')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(250); });
    expect(host.querySelector('.stackv')).toBeNull();
  });

  it('slides in the direction of the tab change', () => {
    mount();
    act(() => tab('stack').click());
    const dx = (v: HTMLElement) => v.style.getPropertyValue('--dx');
    expect(dx(live()[0])).toBe('8px');
    act(() => { vi.advanceTimersByTime(250); });
    act(() => tab('activity').click());
    expect(dx(live()[0])).toBe('-8px');
    expect(live()[0].classList.contains('in')).toBe(true);
  });

  it('switches instantly under reduced motion', () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      mount();
      act(() => tab('stack').click());
      expect(views()).toHaveLength(1);
      expect(host.querySelector('.leave')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
