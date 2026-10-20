// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SnRecordInfo } from '@shared/sn.js';
import { useStore } from '../store';
import { change, emptyDomain, file } from '../fixtures';
import { setIndex } from './data';
import { SnRecordCard } from './SnRecord';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RULE = 'x_app/business_rule/task/Rule__5f000000000000000000000000000061.js';
const rec: SnRecordInfo = { path: RULE, dir: false, sysId: '5f000000000000000000000000000061', table: 'sys_script', name: 'Rule', scope: 'x_app' };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useStore.getState().reset();
  setIndex({ instance: 'acme', scopes: [{ scope: 'x_app' }], records: [rec] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setIndex(null);
});

function show(changes: ReturnType<typeof change>[]) {
  useStore.getState().apply({
    type: 'hello', root: '/p/sn', name: 'sn', files: [file(RULE)], changes, usedBy: [], domain: emptyDomain(), indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] },
  });
  act(() => root.render(<SnRecordCard path={RULE} />));
}

const fact = (term: string) => {
  const dt = [...host.querySelectorAll('dt')].find(d => d.textContent === term);
  return dt?.nextElementSibling?.textContent ?? null;
};

describe('SnRecordCard', () => {
  it('names who saved a version history change that has no attribution', () => {
    show([change(RULE, 'modified', { savedBy: 'dev.user1' })]);
    expect(fact('Change')).toBe('Saved by dev.user1 (version history)');
    expect(fact('Session')).toBeNull();
  });

  it('shows the session, not savedBy, when the change has an attribution', () => {
    show([change(RULE, 'modified', { savedBy: 'dev.user1', attribution: { agent: 'codex', sessionId: 's', confidence: 'exact' } })]);
    expect(fact('Change')).toBeNull();
    expect(fact('Session')).toBe('Codex');
  });

  it('shows neither for a change with no attribution and no savedBy', () => {
    show([change(RULE, 'modified')]);
    expect(fact('Change')).toBeNull();
  });
});
