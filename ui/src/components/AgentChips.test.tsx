// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentSession } from '@shared/types.js';
import { useStore } from '../store';
import { session, emptyDomain } from '../fixtures';
import { AgentChips } from './AgentChips';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function mount(sessions: AgentSession[], paused: boolean) {
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
    events: [], sessions, control: { paused, flags: [] },
  });
  act(() => root.render(<AgentChips />));
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

describe('AgentChips (I3)', () => {
  it('pause shows only on hooked sessions; unhooked ones say they are not connected', () => {
    mount([session({ id: 'h', hooks: true }), session({ id: 'u', agent: 'codex', hooks: false })], true);
    const chips = [...host.querySelectorAll('.agentchip')];
    const hooked = chips.find(c => c.textContent?.includes('Claude Code'))!;
    const loose = chips.find(c => c.textContent?.includes('Codex'))!;
    expect(hooked.className).toContain('paused');
    expect(loose.className).not.toContain('paused');
    expect(loose.className).toContain('working');
    expect(loose.textContent).toContain('not connected');
    expect(loose.querySelector('.nc')?.getAttribute('title')).toBe('Run livemap init to steer this agent');
    expect(hooked.querySelector('.nc')).toBeNull();
  });
});

describe('AgentChips motion', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('chips scale in, and a chip that drops out scales out before it is removed', () => {
    vi.useFakeTimers();
    mount([session({ id: 'a', title: 'A' }), session({ id: 'b', agent: 'codex', title: 'B' })], false);
    const chips = () => [...host.querySelectorAll<HTMLElement>('.agentchip')];
    expect(chips().every(c => c.classList.contains('in'))).toBe(true);
    // Session b goes quiet for longer than the chip window.
    act(() => useStore.getState().apply({ type: 'session', session: session({ id: 'b', agent: 'codex', title: 'B', lastAt: Date.now() - 31 * 60_000 }) }));
    const out = chips().find(c => c.classList.contains('out'))!;
    expect(out.textContent).toContain('Codex');
    expect(out.getAttribute('aria-hidden')).toBe('true');
    expect(out.getAttribute('role')).toBeNull();
    act(() => { vi.advanceTimersByTime(300); });
    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toContain('Claude Code');
  });
});
