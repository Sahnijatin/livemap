import { describe, it, expect, beforeEach } from 'vitest';
import { applyMessage, emptyState } from '@shared/state.js';
import type { ServerMessage } from '@shared/protocol.js';
import { useStore } from './store';
import { file, change, event, session, emptyDomain } from './fixtures';

/** A scripted run of 53 mixed messages after a hello, including summary clears (empty hash). */
function script(): ServerMessage[] {
  const msgs: ServerMessage[] = [];
  const c1 = change('a.ts', 'created');
  for (let i = 0; i < 4; i++) {
    msgs.push({ type: 'agentEvent', event: event({ text: `e${i}` }) });
    msgs.push({ type: 'session', session: session({ id: `s${i % 2}`, status: i % 2 ? 'idle' : 'working' }) });
    msgs.push({ type: 'files', files: [file(`n${i}.ts`, [], { lines: i + 1 })], removed: i === 3 ? ['n0.ts'] : [] });
    msgs.push({ type: 'change', change: i === 0 ? c1 : change(`n${i}.ts`, i === 2 ? 'deleted' : 'modified'), files: [file(`m${i}.ts`)], removed: i === 2 ? ['b.ts'] : [] });
    msgs.push({ type: 'usedBy', usedBy: [{ file: 'a.ts', symbol: `s${i}`, usedIn: ['b.ts'] }] });
    msgs.push({ type: 'domain', domain: { ...emptyDomain(), counts: { routes: i, pages: 0, screens: 0, tables: 0, deps: 0, env: 0 } } });
    msgs.push({ type: 'control', control: { paused: i % 2 === 0, flags: [] } });
    msgs.push({ type: 'indexing', done: i, total: 4 });
    msgs.push({ type: 'attribution', changeId: c1.id, attribution: { agent: 'claude-code', sessionId: `s${i % 2}`, confidence: 'exact' } });
    msgs.push({ type: 'attribution', changeId: 424242, attribution: { agent: 'git', sessionId: 'x', confidence: 'likely' } });
    msgs.push({ type: 'summary', changeId: i % 2 ? c1.id : 424242, summary: `Adds step ${i}` });
    msgs.push({ type: 'fileSummary', path: `n${i % 2}.ts`, hash: i === 3 ? '' : `h${i}`, summary: i === 3 ? '' : `File ${i}` });
    if (i === 2) msgs.push({ type: 'fileSummary', path: 'a.ts', hash: '', summary: '' });
    msgs.push({ type: 'summaryStatus', status: { state: i % 2 ? 'working' : 'ready', provider: 'openai', model: 'm', usedTokens: i * 10, capTokens: 1000, month: '2026-10' } });
  }
  return msgs;
}

const hello = (): ServerMessage => ({
  type: 'hello', root: '/p/shop', name: 'shop', files: [file('a.ts'), file('b.ts'), file('c.ts')],
  changes: [change('c.ts')], usedBy: [], domain: emptyDomain(), indexing: false,
  events: [event()], sessions: [session({ id: 'h1' })], control: { paused: false, flags: [] },
  summaries: { status: { state: 'ready', provider: 'anthropic', model: 'm', usedTokens: 1, capTokens: 1000, month: '2026-10' }, files: { 'a.ts': { hash: 'h0', summary: 'From hello' } } },
});

beforeEach(() => useStore.getState().reset());

describe('shared reducer parity with the UI store', () => {
  it('matches the store after hello, 53 mixed messages, and a second hello', () => {
    const msgs = [hello(), ...script(), hello(), ...script().slice(0, 13)];
    expect(script()).toHaveLength(53);
    let state = emptyState('', '');
    for (const m of msgs) {
      useStore.getState().apply(m);
      state = applyMessage(state, m);
      const ui = useStore.getState();
      expect(Object.fromEntries(state.files.map(f => [f.path, f]))).toEqual(ui.files);
      expect(state.changes).toEqual(ui.changes);
      expect(state.usedBy).toEqual(ui.usedBy);
      expect(state.domain).toEqual(ui.domain);
      expect(state.events).toEqual(ui.events);
      expect(Object.fromEntries(state.sessions.map(x => [x.id, x]))).toEqual(ui.sessions);
      expect(state.control).toEqual(ui.control);
      expect(state.summaries).toEqual(ui.summaries);
    }
  });

  it('matches the store at the caps', () => {
    const msgs: ServerMessage[] = [hello()];
    for (let i = 0; i < 2050; i++) msgs.push({ type: 'agentEvent', event: event() });
    msgs.push({ type: 'agentEvents', events: Array.from({ length: 300 }, () => event()) });
    for (let i = 0; i < 2050; i++) msgs.push({ type: 'change', change: change(`k${i % 7}.ts`), files: [], removed: [] });
    let state = emptyState('', '');
    for (const m of msgs) { useStore.getState().apply(m); state = applyMessage(state, m); }
    const ui = useStore.getState();
    expect(state.events).toHaveLength(2000);
    expect(state.events).toEqual(ui.events);
    expect(state.changes).toHaveLength(2000);
    expect(state.changes).toEqual(ui.changes);
  });
});
