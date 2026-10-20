import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSnArgs } from '../../plugins/servicenow/cli.js';
import { pullScope, resolveScope } from '../../plugins/servicenow/backfill.js';
import { layoutMirror } from '../../plugins/servicenow/mirror.js';
import { NexusClient, DEFAULT_NEXUS_URL } from '../../plugins/servicenow/nexus.js';
import { recordResolver } from '../../plugins/servicenow/records.js';
import { DEFAULT_SKYFORGE_LOG } from '../../plugins/servicenow/skyforge-log.js';
import { snRoot, writeMirror } from '../../plugins/servicenow/writer.js';
import { AgentHub } from '../../src/agents/hub.js';
import { Attributor } from '../../src/agents/attribution.js';
import { toolMeta } from '../../src/agents/labels.js';
import type { ChangeSummary } from '../../src/shared/types.js';
import { rmTree } from '../helpers/platform.js';
import { loadFixture, startMockNexus } from '../helpers/mock-nexus.js';

const fail = (m: string): never => { throw new Error(m); };

describe('parseSnArgs', () => {
  it('reads every option, with = or a space', () => {
    expect(parseSnArgs(['proj', '--scope', 'x_snc_cc_offering', '--instance=inmorphisdemo3', '--nexus', 'http://127.0.0.1:4000/mcp', '--port=0', '--no-open', '--no-history', '--mirror-only',
      '--skyforge-log', 'D:\\logs\\mcp.log', '--log-window=90', '--poll', '10'], fail))
      .toEqual({
        dir: 'proj', scope: 'x_snc_cc_offering', instance: 'inmorphisdemo3', nexus: 'http://127.0.0.1:4000/mcp', port: 0, open: false, history: false, mirrorOnly: true,
        skyforgeLog: 'D:\\logs\\mcp.log', logWindowSec: 90, pollSec: 10,
      });
  });
  it('defaults nexus, port, open, history and the SkyForge log', () => {
    expect(parseSnArgs(['--scope', 'x_a'], fail)).toMatchObject({
      dir: '.', nexus: DEFAULT_NEXUS_URL, port: 4317, open: true, history: true, mirrorOnly: false,
      skyforgeLog: DEFAULT_SKYFORGE_LOG, logWindowSec: 60, pollSec: 5,
    });
    expect(parseSnArgs(['--scope', 'x_a', '--poll', 'off'], fail).pollSec).toBeNull();
    expect(() => parseSnArgs(['--scope', 'x', '--poll', '1'], fail)).toThrow(/invalid --poll/);
    expect(() => parseSnArgs(['--scope', 'x', '--poll', '61'], fail)).toThrow(/invalid --poll/);
    expect(DEFAULT_SKYFORGE_LOG).toBe(path.join(os.homedir(), '.skyforge', 'skyforge-mcp.log'));
    expect(parseSnArgs(['--scope', 'x_a', '--skyforge-log', 'none'], fail).skyforgeLog).toBeNull();
    expect(() => parseSnArgs(['--scope', 'x', '--log-window', '0'], fail)).toThrow(/invalid --log-window/);
    expect(() => parseSnArgs(['--scope', 'x', '--log-window', '5m'], fail)).toThrow(/invalid --log-window/);
  });
  it('requires --scope, and rejects bad values and unknown options', () => {
    expect(() => parseSnArgs([], fail)).toThrow(/--scope is required/);
    expect(() => parseSnArgs(['--scope'], fail)).toThrow(/--scope needs a value/);
    expect(() => parseSnArgs(['--scope', '--instance'], fail)).toThrow(/needs a value/);
    expect(() => parseSnArgs(['--scope', 'x', '--nexus', 'not a url'], fail)).toThrow(/invalid --nexus/);
    expect(() => parseSnArgs(['--scope', 'x', '--port', '99999'], fail)).toThrow(/invalid port/);
    expect(() => parseSnArgs(['--scope', 'x', '--record'], fail)).toThrow(/unknown option/);
    expect(() => parseSnArgs(['--scope', 'x', 'a', 'b'], fail)).toThrow(/unexpected argument/);
  });
});

describe('recordResolver and attribution of a record write', () => {
  const fx = loadFixture();
  let dir: string;
  let root: string;
  beforeAll(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-snr-')));
    const m = await startMockNexus();
    const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3' });
    try {
      const scope = await resolveScope(c, 'x_snc_cc_offering');
      const pulled = await pullScope(c, scope);
      root = snRoot(dir);
      const { files, manifest } = layoutMirror({ instance: 'inmorphisdemo3', scope, ...pulled, rootAbs: root });
      writeMirror(root, files, manifest);
    } finally { await c.close(); await m.close(); }
  });
  afterAll(() => rmTree(dir));

  const widget = () => fx.tables.sp_widget.find(w => w.id === 'bb-dpdp-consent')!;
  const wdir = () => `x_snc_cc_offering/widget/bb-dpdp-consent__${widget().sys_id}`;

  it('maps every file of a folder record to that record, and embedded records to their file', () => {
    const of = recordResolver(root);
    for (const f of ['meta.json', 'template.html', 'server.js', 'client.js']) {
      expect(of(`${wdir()}/${f}`), f).toEqual({ instance: 'inmorphisdemo3', table: 'sp_widget', sysId: widget().sys_id, name: 'BB DPDP Consent' });
    }
    const br = fx.tables.sys_script[0];
    expect(of(`x_snc_cc_offering/business_rule/${br.collection}/${br.name}__${br.sys_id}.js`)).toMatchObject({ table: 'sys_script', sysId: br.sys_id });
    const page = fx.tables.sp_page.find(p => p.id === 'cc_home')!;
    expect(of(`x_snc_cc_offering/page/cc_home__${page.sys_id}/layout.json`)).toMatchObject({ table: 'sp_page', sysId: page.sys_id });
    expect(of('x_snc_cc_offering/nope.js')).toBeUndefined();
  });

  it('attributes a widget template change exactly to tool_execute(sn_push_artifact) on that widget', () => {
    const hub = new AgentHub(root);
    const attr = new Attributor(hub, { recordOf: recordResolver(root) });
    try {
      const name = 'nexus_ses_ebf63bf49ffeGGE3hEhWQuinBE_tool_execute';
      const input = { tool: 'sn_push_artifact', args: { table: 'sp_widget', sys_id: widget().sys_id, field: 'template' } };
      hub.ingestRaw([{ agent: 'other', sessionId: 'ses_1', at: 1000, type: 'tool_start', tool: { id: 'c1', name, label: 'push', paths: [], ...toolMeta(name, input) } }], { agent: 'other', cwd: root, hooks: true });
      const change = { id: 1, path: `${wdir()}/template.html`, kind: 'modified', at: 3000 } as ChangeSummary;
      expect(attr.attribute(change, 3000)).toMatchObject({ sessionId: 'ses_1', confidence: 'exact' });
      const other = { id: 2, path: `x_snc_cc_offering/widget/bb-payment__${fx.tables.sp_widget.find(w => w.id === 'bb-payment')!.sys_id}/template.html`, kind: 'modified', at: 3000 } as ChangeSummary;
      expect(attr.attribute(other, 3000)?.confidence).toBe('likely');
    } finally { attr.stop(); hub.stop(); }
  });
});
