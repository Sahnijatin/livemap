// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
