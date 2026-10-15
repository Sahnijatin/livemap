import { describe, it, expect } from 'vitest';
import {
  baseToolName, classifyTool, isWriteCall, recordTargetsOf, registerToolRule, resultSysIds, sameRecord, takesLocalPaths, toolServer, unwrapTool,
} from '../../src/shared/tools.js';

// The exact names SkyForge v4.4.2 sends to plugin hooks (verified 15 Oct 2026).
const SES = 'ses_ebf63bf49ffeGGE3hEhWQuinBE';
const EXEC = `nexus_${SES}_tool_execute`;
const SEARCH = `nexus_${SES}_tool_search`;
const SYS_ID = '871f6b2a1b2c3d4e5f60718293a4b5c6';

describe('baseToolName and toolServer', () => {
  it('strips the nexus session prefix', () => {
    expect(baseToolName(EXEC)).toBe('tool_execute');
    expect(baseToolName(SEARCH)).toBe('tool_search');
    expect(baseToolName(`nexus_${SES}_sn_query_table`)).toBe('sn_query_table');
    expect(toolServer(EXEC)).toBe('nexus');
  });

  it('strips Claude-style MCP prefixes, keeping the server', () => {
    expect(baseToolName('mcp__skyforge-nexus__tool_execute')).toBe('tool_execute');
    expect(baseToolName('mcp__github__create_or_update_file')).toBe('create_or_update_file');
    expect(toolServer('mcp__github__create_or_update_file')).toBe('github');
  });

  it('leaves plain names alone', () => {
    expect(baseToolName('sn_record_manage')).toBe('sn_record_manage');
    expect(baseToolName('Edit')).toBe('Edit');
    expect(baseToolName('nexus_')).toBe('nexus_');
    expect(toolServer('Edit')).toBeUndefined();
  });
});

describe('unwrapTool', () => {
  it('unwraps tool_execute {tool, args}', () => {
    expect(unwrapTool(EXEC, { tool: 'sn_get_instance_info', args: {} })).toEqual({ name: 'tool_execute', inner: 'sn_get_instance_info', args: {} });
  });

  it('parses args given as JSON text, and defaults missing args to {}', () => {
    expect(unwrapTool('tool_execute', { tool: 'sn_query_table', args: '{"table":"sp_widget"}' }).args).toEqual({ table: 'sp_widget' });
    expect(unwrapTool('tool_execute', { tool: 'sn_session_context' }).args).toEqual({});
  });

  it('keeps a call with no inner tool as is', () => {
    expect(unwrapTool(EXEC, { query: 'x' })).toEqual({ name: 'tool_execute', args: { query: 'x' } });
    expect(unwrapTool('sn_query_table', { table: 't' })).toEqual({ name: 'sn_query_table', args: { table: 't' } });
  });
});

describe('classifyTool: SkyForge top tools by volume', () => {
  it('sn_execute_background_script writes, with no record target', () => {
    const c = classifyTool(EXEC, { tool: 'sn_execute_background_script', args: { script: 'gs.info(1)' } });
    expect(c).toMatchObject({ name: 'tool_execute', inner: 'sn_execute_background_script', server: 'nexus', access: 'write', known: true, targets: [] });
  });

  it('sn_query_table reads, direct and wrapped', () => {
    expect(classifyTool('sn_query_table', { table: 'sys_metadata' }).access).toBe('read');
    expect(classifyTool(EXEC, { tool: 'sn_query_table', args: { table: 'sp_widget' } })).toMatchObject({ inner: 'sn_query_table', access: 'read' });
    expect(classifyTool(`nexus_${SES}_sn_query_table`, { table: 'sp_widget' })).toMatchObject({ name: 'sn_query_table', access: 'read' });
  });

  it('sn_record_manage writes on update and reads on get', () => {
    const up = classifyTool(EXEC, { tool: 'sn_record_manage', args: { table: 'sys_script', action: 'update', sys_id: SYS_ID, data: { active: true } } });
    expect(up.access).toBe('write');
    expect(up.targets).toEqual([{ kind: 'record', instance: '', table: 'sys_script', sysId: SYS_ID }]);
    expect(classifyTool('sn_record_manage', { table: 'sys_script', action: 'get', sys_id: SYS_ID })).toMatchObject({ access: 'read', targets: [] });
  });

  it('sn_update_set_manage targets the update set by name', () => {
    const c = classifyTool(EXEC, { tool: 'sn_update_set_manage', args: { action: 'create', name: 'CC Offering v2' } });
    expect(c.access).toBe('write');
    expect(c.targets).toEqual([{ kind: 'record', instance: '', table: 'sys_update_set', name: 'CC Offering v2' }]);
    expect(classifyTool('sn_update_set_manage', { action: 'list' }).access).toBe('read');
  });

  it('sn_push_artifact writes its record; sn_pull_artifact only reads the instance', () => {
    const push = classifyTool(EXEC, { tool: 'sn_push_artifact', args: { table: 'sp_widget', sys_id: SYS_ID, field: 'template' } });
    expect(push).toMatchObject({ inner: 'sn_push_artifact', access: 'write' });
    expect(push.targets[0]).toMatchObject({ table: 'sp_widget', sysId: SYS_ID });
    expect(classifyTool(EXEC, { tool: 'sn_pull_artifact', args: { table: 'sp_widget', sys_id: SYS_ID } }).access).toBe('read');
  });

  it('nexus direct tools and gateways', () => {
    for (const t of ['sn_get_table_metadata', 'sn_discover_platform_tables', 'sn_get_instance_info', 'sn_session_context']) expect(classifyTool(t).access).toBe('read');
    expect(classifyTool(SEARCH, { query: 'widget', limit: 5 })).toMatchObject({ name: 'tool_search', access: 'other', known: true });
    expect(classifyTool('sn_load_skill', { name: 'x' }).access).toBe('other');
    expect(classifyTool(EXEC, { tool: 'sn_intermediate_flow', args: {} }).access).toBe('write');
    // tool_execute with no inner tool is neither a read nor a write.
    expect(classifyTool(EXEC, {})).toMatchObject({ access: 'other', known: false });
  });

  it('sn_create_* tools write and name their table', () => {
    const c = classifyTool(EXEC, { tool: 'sn_create_field', args: { table: 'x_snc_cc_offering_credit_card_application', column_label: 'PAN Verified' } });
    expect(c.access).toBe('write');
    expect(c.targets[0]).toMatchObject({ table: 'x_snc_cc_offering_credit_card_application' });
  });

  it('fills the instance from context and adds sys_ids from a create result', () => {
    const c = classifyTool('sn_record_manage', { table: 'sys_script', action: 'create', name: 'Set offer' }, {
      instance: 'inmorphisdemo3', output: JSON.stringify({ success: true, data: { sys_id: SYS_ID } }),
    });
    expect(c.targets).toEqual([
      { kind: 'record', instance: 'inmorphisdemo3', table: 'sys_script', name: 'Set offer' },
      { kind: 'record', instance: 'inmorphisdemo3', table: 'sys_script', sysId: SYS_ID, name: 'Set offer' },
    ]);
  });
});

describe('classifyTool: built-ins and other MCP tools', () => {
  it('built-in families keep their meaning', () => {
    expect(classifyTool('Edit', { file_path: 'a' })).toMatchObject({ family: 'edit', access: 'write' });
    expect(classifyTool('Bash', { command: 'ls' })).toMatchObject({ family: 'shell', access: 'write' });
    expect(classifyTool('Read')).toMatchObject({ family: 'read', access: 'read' });
    expect(classifyTool('Task')).toMatchObject({ family: 'subagent', access: 'other' });
  });

  it('GitHub MCP writes and reads by verb', () => {
    expect(classifyTool('mcp__github__create_or_update_file', { path: 'a.ts' })).toMatchObject({ server: 'github', access: 'write', known: true });
    expect(classifyTool('mcp__github__get_file_contents').access).toBe('read');
    expect(classifyTool('mcp__github__list_issues').access).toBe('read');
  });

  it('an MCP tool named like a built-in is not a built-in', () => {
    expect(classifyTool('mcp__fs__read').family).toBeUndefined();
  });

  it('unknown tools are flagged unknown; built-in-looking names never guess from verbs', () => {
    expect(classifyTool('mcp__figma__frobnicate')).toMatchObject({ access: 'other', known: false });
    expect(classifyTool('update_plan')).toMatchObject({ access: 'other', known: false });
    expect(classifyTool('TodoWrite')).toMatchObject({ access: 'other', known: false });
  });

  it('isWriteCall', () => {
    expect(isWriteCall(EXEC, { tool: 'sn_record_manage', args: { table: 't', action: 'delete', sys_id: SYS_ID } })).toBe(true);
    expect(isWriteCall(EXEC, { tool: 'sn_query_table', args: { table: 't' } })).toBe(false);
  });
});

describe('registerToolRule', () => {
  it('adds a rule ahead of the built-in ones, and removes it', () => {
    const off = registerToolRule({ match: 'sn_query_table', access: 'write' });
    try { expect(classifyTool('sn_query_table').access).toBe('write'); } finally { off(); }
    expect(classifyTool('sn_query_table').access).toBe('read');
  });

  it('matches patterns and supplies targets', () => {
    const off = registerToolRule({ match: /^acme_save_/, access: 'write', targets: (a) => recordTargetsOf(a, { table: 'acme' }) });
    try { expect(classifyTool('mcp__acme__acme_save_doc', { name: 'n' }).targets).toEqual([{ kind: 'record', instance: '', table: 'acme', name: 'n' }]); } finally { off(); }
  });
});

describe('helpers', () => {
  it('resultSysIds reads common result shapes and ignores non-ids', () => {
    expect(resultSysIds({ sys_id: SYS_ID })).toEqual([SYS_ID]);
    expect(resultSysIds({ result: { sys_id: SYS_ID } })).toEqual([SYS_ID]);
    expect(resultSysIds(JSON.stringify({ success: true, data: { record: { sys_id: SYS_ID } } }))).toEqual([SYS_ID]);
    expect(resultSysIds('not json')).toEqual([]);
    expect(resultSysIds({ sys_id: 'nope' })).toEqual([]);
  });

  it('sameRecord compares sys_id, then name, and instance when both say', () => {
    const t = { kind: 'record' as const, instance: 'a', table: 'sys_script', sysId: SYS_ID };
    expect(sameRecord(t, { table: 'sys_script', sysId: SYS_ID })).toBe(true);
    expect(sameRecord(t, { instance: 'b', table: 'sys_script', sysId: SYS_ID })).toBe(false);
    expect(sameRecord(t, { table: 'sys_script_include', sysId: SYS_ID })).toBe(false);
    expect(sameRecord({ kind: 'record', instance: '', table: 'sys_update_set', name: 'X' }, { table: 'sys_update_set', name: 'X', sysId: SYS_ID })).toBe(true);
    expect(sameRecord({ kind: 'record', instance: '', table: 't' }, { table: 't' })).toBe(false);
  });
});

describe('review of #64', () => {
  const ID2 = '9a8b7c6d5e4f30211203f4e5d6c7b8a9';

  it('item 2: resultSysIds reads the nexus tool_execute wrapper and nested shapes', () => {
    // Shape checked live with sn_get_instance_info: {success, tool, result: {success, data: {...}}}.
    const wrapped = { success: true, tool: 'sn_record_manage', result: { success: true, data: { sys_id: SYS_ID, name: 'Set offer' } } };
    expect(resultSysIds(wrapped)).toEqual([SYS_ID]);
    expect(resultSysIds(JSON.stringify(wrapped))).toEqual([SYS_ID]);
    expect(resultSysIds({ success: true, tool: 'x', result: { success: true, data: { record: { sys_id: SYS_ID } } } })).toEqual([SYS_ID]);
    expect(resultSysIds({ success: true, data: { records: [{ sys_id: SYS_ID }, { sys_id: ID2 }], count: 2, has_more: false } })).toEqual([SYS_ID]);
    expect(resultSysIds({ result: { data: { records: [{ sys_id: ID2 }] } } })).toEqual([ID2]);
  });

  it('item 2: a result cut off mid-JSON falls back to the first few sys_id pairs', () => {
    const full = JSON.stringify({ success: true, tool: 'sn_record_manage', result: { success: true, data: { sys_id: SYS_ID, script: 'x'.repeat(5000) } } });
    const cut = full.slice(0, 4000);
    expect(() => JSON.parse(cut)).toThrow();
    expect(resultSysIds(cut)).toEqual([SYS_ID]);
    const many = '{"data":{"records":[' + Array.from({ length: 9 }, (_, i) => `{"sys_id" : "${String(i).repeat(32)}"}`).join(',');
    expect(resultSysIds(many)).toHaveLength(5);
    expect(resultSysIds('{"sys_id":"not-an-id"')).toEqual([]);
  });

  it('item 2: a create through tool_execute gets its new sys_id from the wrapped result', () => {
    const output = JSON.stringify({ success: true, tool: 'sn_record_manage', result: { success: true, data: { sys_id: SYS_ID } } });
    const c = classifyTool(EXEC, { tool: 'sn_record_manage', args: { table: 'sys_script_include', action: 'create', data: { name: 'OfferUtils', api_name: 'x_snc_cc_offering.OfferUtils' } } }, { output });
    expect(c.targets).toEqual([
      { kind: 'record', instance: '', table: 'sys_script_include', name: 'OfferUtils' },
      { kind: 'record', instance: '', table: 'sys_script_include', sysId: SYS_ID, name: 'OfferUtils' },
    ]);
  });

  it('item 3: sn_intermediate_flow reads on get, writes on every other action, and targets sys_hub_flow', () => {
    expect(classifyTool(EXEC, { tool: 'sn_intermediate_flow', args: { action: 'get', sys_id: SYS_ID } })).toMatchObject({ access: 'read', targets: [] });
    for (const action of ['create_flow', 'create_subflow', 'promote', 'populate_inputs', 'update_flow', 'delete_flow', 'add_component', 'delete_component', 'update_trigger']) {
      expect(classifyTool(EXEC, { tool: 'sn_intermediate_flow', args: { action } }).access).toBe('write');
    }
    expect(classifyTool(EXEC, { tool: 'sn_intermediate_flow', args: { action: 'update_flow', sys_id: SYS_ID } }).targets).toEqual([
      { kind: 'record', instance: '', table: 'sys_hub_flow', sysId: SYS_ID },
    ]);
    expect(classifyTool(EXEC, { tool: 'sn_intermediate_flow', args: { action: 'create_flow', name: 'Approve offer' } }).targets).toEqual([
      { kind: 'record', instance: '', table: 'sys_hub_flow', name: 'Approve offer' },
    ]);
  });

  it('item 4: an update set name is not a record name, except for sn_update_set_manage', () => {
    const c = classifyTool('sn_record_manage', { table: 'sys_script', action: 'update', sys_id: SYS_ID, update_set: 'CC v2' });
    expect(c.targets).toEqual([{ kind: 'record', instance: '', table: 'sys_script', sysId: SYS_ID }]);
    expect(classifyTool('sn_record_manage', { table: 'sys_script', action: 'create', update_set_name: 'CC v2' }).targets).toEqual([
      { kind: 'record', instance: '', table: 'sys_script' },
    ]);
    expect(classifyTool('sn_update_set_manage', { action: 'switch', update_set: 'CC v2' }).targets).toEqual([
      { kind: 'record', instance: '', table: 'sys_update_set', name: 'CC v2' },
    ]);
  });

  it('item 5: a create names its record inside data', () => {
    expect(classifyTool('sn_record_manage', { table: 'sys_script_include', action: 'create', data: { api_name: 'x.Utils' } }).targets[0]).toMatchObject({ name: 'x.Utils' });
    expect(classifyTool('sn_record_manage', { table: 'sys_script', action: 'create', data: { sys_name: 'Set offer' } }).targets[0]).toMatchObject({ name: 'Set offer' });
    // A name at the top level wins over one in data.
    expect(classifyTool('sn_record_manage', { table: 't', action: 'create', name: 'top', data: { name: 'inner' } }).targets[0]).toMatchObject({ name: 'top' });
  });

  it('item 6: only built-ins, local filesystem servers and sn_pull_artifact take local paths', () => {
    expect(takesLocalPaths('Edit', { file_path: 'a' })).toBe(true);
    expect(takesLocalPaths('mcp__filesystem__write_file', { path: 'a' })).toBe(true);
    expect(takesLocalPaths('mcp__github__create_or_update_file', { path: 'a' })).toBe(false);
    expect(takesLocalPaths(EXEC, { tool: 'sn_pull_artifact', args: { file_path: 'a' } })).toBe(true);
    expect(takesLocalPaths('sn_pull_artifact', { file_path: 'a' })).toBe(true);
    expect(takesLocalPaths(EXEC, { tool: 'sn_push_artifact', args: { file_path: 'a' } })).toBe(false);
    expect(takesLocalPaths('sn_push_artifact', { file_path: 'a' })).toBe(false);
    expect(takesLocalPaths(EXEC, { tool: 'write_file', args: { file_path: 'a' } })).toBe(false);
  });
});
