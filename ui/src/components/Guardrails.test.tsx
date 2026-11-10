// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuardState } from '@shared/types.js';
import { useStore } from '../store';
import { Guardrails } from './Guardrails';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const show = (guard?: GuardState) => {
  act(() => useStore.getState().apply({ type: 'control', control: { paused: false, flags: [], ...(guard ? { guard } : {}) } }));
  act(() => root.render(<Guardrails />));
};
const guard: GuardState = {
  file: '.livemap/guardrails.json',
  rules: [
    { paths: ['db/migrations/**', '.env*'], commands: [], action: 'block', on: 'write', message: 'Ask first.' },
    { paths: [], commands: ['git push'], action: 'pause', on: 'write' },
  ],
  errors: ['rule 3: needs "paths" or "commands"'],
  hits: [{ at: Date.now(), rule: 0, action: 'block', target: 'db/migrations/001.sql', agent: 'claude-code', sessionId: 's1', tool: 'Edit' }],
};

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

describe('Guardrails', () => {
  it('says how to add rules when the project has none', () => {
    show();
    expect(host.textContent).toContain('Guardrails');
    expect(host.textContent).toContain('.livemap/guardrails.json');
    expect(host.querySelector('.guardrule')).toBeNull();
  });
  it('lists each rule with its action, patterns and message', () => {
    show(guard);
    const rows = [...host.querySelectorAll('.guardrule')].map(r => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Block');
    expect(rows[0]).toContain('db/migrations/**');
    expect(rows[0]).toContain('.env*');
    expect(rows[0]).toContain('Ask first.');
    expect(rows[1]).toContain('Pause');
    expect(rows[1]).toContain('git push');
  });
  it('shows file errors and the latest blocked calls, newest first', () => {
    show({ ...guard, hits: [...guard.hits, { at: Date.now(), rule: 1, action: 'pause', target: 'command contains "git push"', agent: 'cursor', sessionId: 'c', tool: 'Shell' }] });
    expect(host.querySelector('.guard-err')?.textContent).toContain('rule 3: needs "paths" or "commands"');
    const hits = [...host.querySelectorAll('.guardhit')].map(h => h.textContent);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('command contains "git push"');
    expect(hits[0]).toContain('Cursor');
    expect(hits[1]).toContain('db/migrations/001.sql');
    expect(hits[1]).toContain('Claude Code');
  });
  it('hides the how-to in an exported replay', () => {
    useStore.setState({ replay: true });
    show();
    expect(host.textContent).toBe('');
  });
});
