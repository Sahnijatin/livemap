import { describe, it, expect } from 'vitest';
import type { SnRecordInfo } from '@shared/sn.js';
import { change, event, session } from '../fixtures';
import { levelOf, openUrl, recordOf, toolWords, whyOf } from './data';
import { activeCount, filtersUrl, readFilters, viewFilter } from './filters';
import { unknownTools } from './SnHost';

const rec = (path: string, extra: Partial<SnRecordInfo> = {}): SnRecordInfo => ({
  path, dir: !path.endsWith('.js'), sysId: '5f000000000000000000000000000001', table: 'sp_widget', name: 'W', scope: path.split('/')[0], ...extra,
});
const W = 'x_app/widget/carousel__5f0000000000000000000000000000c2';
const R = 'x_app/business_rule/task/Rule__5f000000000000000000000000000061.js';
const byPath = new Map<string, SnRecordInfo>([
  [W, rec(W, { updateSetName: 'Card refresh' })],
  [R, rec(R, { table: 'sys_script', updateSetName: 'Rules' })],
]);

describe('openUrl', () => {
  const id = '5f0000000000000000000000000000c2';
  it('links a record on a ServiceNow host, from a name, a host or a URL', () => {
    expect(openUrl('acme', 'sp_widget', id)).toEqual({ url: `https://acme.service-now.com/sp_widget.do?sys_id=${id}`, host: 'acme.service-now.com', blocked: false });
    expect(openUrl('ACME.service-now.com', 'sp_widget', id).url).toBe(`https://acme.service-now.com/sp_widget.do?sys_id=${id}`);
    expect(openUrl('https://acme.service-now.com/', 'sys_script', id).url).toBe(`https://acme.service-now.com/sys_script.do?sys_id=${id}`);
    expect(openUrl('gov.servicenowservices.com', 'sys_script', id).url).toBe(`https://gov.servicenowservices.com/sys_script.do?sys_id=${id}`);
  });
  it('gives no link for another domain unless it is allowed', () => {
    expect(openUrl('evil.example', 'sp_widget', id)).toEqual({ url: null, host: 'evil.example', blocked: true });
    expect(openUrl('acme.service-now.com.evil.example', 'sp_widget', id).blocked).toBe(true);
    expect(openUrl('xservice-now.com', 'sp_widget', id).blocked).toBe(true);
    expect(openUrl('sn.corp.example', 'sp_widget', id, ['corp.example']).url).toBe(`https://sn.corp.example/sp_widget.do?sys_id=${id}`);
  });
  it('gives no link for a malformed instance, table or sys_id', () => {
    expect(openUrl('', 'sp_widget', id).url).toBeNull();
    expect(openUrl('acme', 'sp_widget"><x', id).url).toBeNull();
    expect(openUrl('acme', 'sp_widget', 'not-an-id').url).toBeNull();
    expect(openUrl('ac me', 'sp_widget', id)).toEqual({ url: null, host: null, blocked: false });
  });
});

describe('recordOf', () => {
  it('finds a file record by its file and a folder record from any file under it', () => {
    expect(recordOf(byPath, R)?.table).toBe('sys_script');
    expect(recordOf(byPath, `${W}/server.js`)?.path).toBe(W);
    expect(recordOf(byPath, `${W}/meta.json`)?.path).toBe(W);
    expect(recordOf(byPath, 'x_app/widget/other__5f000000000000000000000000000099/meta.json')).toBeUndefined();
  });
});

describe('filters', () => {
  it('read from and write to the URL, keeping other parameters', () => {
    expect(readFilters('?scope=x_app&set=Card%20refresh&who=human&conf=ambiguous&session=s1')).toEqual({ scope: 'x_app', set: 'Card refresh', who: 'human', conf: 'ambiguous', session: 's1' });
    expect(readFilters('?who=robot&conf=sure')).toEqual({});
    expect(filtersUrl('http://h/?x=1#a', { scope: 'x_app', conf: 'none' })).toBe('/?x=1&scope=x_app&conf=none#a');
    expect(filtersUrl('http://h/?scope=x_app&set=a', {})).toBe('/');
    expect(activeCount({ scope: 'x', who: 'agent' })).toBe(2);
  });

  it('are off with no choice made', () => {
    expect(viewFilter({}, byPath, [])).toBeNull();
  });

  it('scope and update set keep the files of matching records', () => {
    const f = viewFilter({ scope: 'x_app', set: 'Card refresh' }, byPath, [])!;
    expect(f.path(`${W}/server.js`)).toBe(true);
    expect(f.path(R)).toBe(false);
    expect(viewFilter({ scope: 'x_other' }, byPath, [])!.path(`${W}/server.js`)).toBe(false);
    // A file that belongs to no record still has a scope: its top folder.
    expect(viewFilter({ scope: 'x_app' }, byPath, [])!.path('x_app/other/thing.json')).toBe(true);
  });

  it('session, agent or human, and confidence keep matching changes and the files they touched', () => {
    const agent = change(R, 'modified', { attribution: { agent: 'codex', sessionId: 's1', confidence: 'exact' } });
    const human = change(`${W}/server.js`, 'modified');
    const changes = [agent, human];
    const byHuman = viewFilter({ who: 'human' }, byPath, changes)!;
    expect(byHuman.change(human)).toBe(true);
    expect(byHuman.change(agent)).toBe(false);
    expect(byHuman.path(`${W}/server.js`)).toBe(true);
    expect(byHuman.path(R)).toBe(false);
    expect(byHuman.event(event({ sessionId: 's1' }))).toBe(false);
    const unattributed = viewFilter({ conf: 'none' }, byPath, changes)!;
    expect(unattributed.change(human)).toBe(true);
    expect(unattributed.change(agent)).toBe(false);
    const s1 = viewFilter({ session: 's1' }, byPath, changes)!;
    expect(s1.change(agent)).toBe(true);
    expect(s1.event(event({ sessionId: 's1' }))).toBe(true);
    expect(s1.event(event({ sessionId: 's2' }))).toBe(false);
    expect(viewFilter({ conf: 'exact', set: 'Card refresh' }, byPath, changes)!.change(agent)).toBe(false);
  });

  it('key changes with the choices, not with the data', () => {
    const a = viewFilter({ scope: 'x_app' }, byPath, [])!;
    const b = viewFilter({ scope: 'x_app' }, byPath, [change(R)])!;
    expect(a.key).toBe(b.key);
    expect(viewFilter({ scope: 'x_app', who: 'agent' }, byPath, [])!.key).not.toBe(a.key);
  });
});

describe('why', () => {
  it('Goal is the turn prompt, Step the last message before the call, Action the call in plain words', () => {
    const events = [
      event({ id: 1, sessionId: 's1', type: 'prompt', text: 'Add a card carousel to the home page' }),
      event({ id: 2, sessionId: 's1', type: 'message', text: 'First I will read the widget.' }),
      event({ id: 3, sessionId: 's2', type: 'message', text: 'Another session.' }),
      event({ id: 4, sessionId: 's1', type: 'message', text: 'Now I update the business rule.' }),
      event({ id: 5, sessionId: 's1', type: 'tool_start', tool: { name: 'mcp__skyforge-nexus__tool_execute', inner: 'sn_record_manage', label: 'x', paths: [] } }),
      event({ id: 6, sessionId: 's1', type: 'message', text: 'Done.' }),
    ];
    const c = change(R, 'modified', { attribution: { agent: 'codex', sessionId: 's1', eventId: 5, confidence: 'exact' } });
    const w = whyOf(c, 'Business rule', events, { s1: session({ id: 's1', title: 'Cards' }) });
    expect(w).toMatchObject({ goal: 'Add a card carousel to the home page', step: 'Now I update the business rule.', action: 'Updated business rule via record manage' });
    expect(w.session?.title).toBe('Cards');
  });

  it('without the call event, only the intent; without an attribution, nothing', () => {
    const c = change(R, 'created', { attribution: { agent: 'codex', sessionId: 's1', eventId: 99, confidence: 'likely', intent: 'Make the rule' } });
    expect(whyOf(c, 'Business rule', [event({ id: 1, sessionId: 's1', type: 'prompt', text: 'Old prompt' })], {})).toMatchObject({ goal: 'Make the rule' });
    expect(whyOf(change(R), 'Business rule', [], {})).toEqual({});
  });

  it('reads confidence levels and tool names', () => {
    expect(levelOf(undefined)).toBe('none');
    expect(levelOf({ agent: 'codex', sessionId: 's', confidence: 'exact' })).toBe('exact');
    expect(toolWords('nexus_ses_ab12_sn_push_artifact')).toBe('push artifact');
    expect(toolWords('mcp__skyforge-nexus__sn_update_set_manage')).toBe('update set manage');
  });
});

describe('unknownTools', () => {
  it('counts calls of tools the classifier cannot place, most called first', () => {
    const call = (name: string, input: unknown = {}) => event({ type: 'tool_start', tool: { name, label: name, input, paths: [] } });
    const list = unknownTools([
      call('mcp__skyforge-nexus__sn_frobnicate_widget'), call('mcp__skyforge-nexus__sn_frobnicate_widget'),
      call('mcp__skyforge-nexus__tool_execute', { tool: 'sn_twiddle', args: {} }),
      call('Edit', { file_path: 'a.ts' }), call('mcp__skyforge-nexus__sn_query_table', { table: 'sys_script' }),
      event({ type: 'tool_end', tool: { name: 'mcp__x__sn_frobnicate_widget', label: 'x', paths: [] } }),
    ]);
    expect(list).toEqual([['sn_frobnicate_widget', 2], ['sn_twiddle', 1]]);
  });
});
