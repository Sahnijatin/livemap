import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instanceInfo, pullScope, resolveScope, ScopeNotFoundError } from '../../plugins/servicenow/backfill.js';
import { clean, layoutMirror, readHeader, SECRET_FIELD } from '../../plugins/servicenow/mirror.js';
import { NexusClient } from '../../plugins/servicenow/nexus.js';
import { ensureGitignored, readManifest, snRoot, writeMirror } from '../../plugins/servicenow/writer.js';
import { PATH_MAX } from '../../plugins/servicenow/paths.js';
import { serviceNowAnalyzer } from '../../plugins/servicenow/analyzer.js';
import { ProjectModel } from '../../src/engine/project.js';
import { ANALYZERS } from '../../src/engine/domain/index.js';
import { buildDomainIndex } from '../../src/engine/domain/build-index.js';
import { expectMode, rmTree } from '../helpers/platform.js';
import { loadFixture, startMockNexus, type MockNexus } from '../helpers/mock-nexus.js';

const fx = loadFixture();
const open: { close(): Promise<void> }[] = [];
let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sn-'))); });
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  rmTree(dir);
});
async function setup(opts: Parameters<typeof startMockNexus>[0] = {}): Promise<{ m: MockNexus; c: NexusClient }> {
  const m = await startMockNexus(opts);
  open.push(m);
  const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3', backoffMs: 1 });
  open.push(c);
  return { m, c };
}
async function backfill(c: NexusClient) {
  const scope = await resolveScope(c, 'x_snc_cc_offering');
  const pulled = await pullScope(c, scope);
  const root = snRoot(dir);
  const { files, manifest } = layoutMirror({ instance: 'inmorphisdemo3', scope, ...pulled, rootAbs: root, pulledAt: '2026-10-15T00:00:00.000Z' });
  const res = writeMirror(root, files, manifest);
  return { scope, pulled, files, manifest, root, res };
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

describe('scope and instance', () => {
  it('resolves a scope by namespace or sys_id, and reports a missing one', async () => {
    const { c } = await setup();
    expect(await resolveScope(c, 'x_snc_cc_offering')).toEqual({ sys_id: fx.scope.sys_id, scope: 'x_snc_cc_offering', name: 'Credit Card Offering', version: '1.0.0' });
    expect((await resolveScope(c, fx.scope.sys_id)).scope).toBe('x_snc_cc_offering');
    await expect(resolveScope(c, 'x_nope')).rejects.toThrow(ScopeNotFoundError);
  });
  it('reads the instance through tool_execute, enabling it with tool_search when needed', async () => {
    const { c, m } = await setup({ needsSearch: ['sn_get_instance_info'] });
    expect(await instanceInfo(c)).toEqual({ name: 'inmorphisdemo3', release: 'brazil', patch: 'patch1' });
    expect(m.calls.some(x => x.tool === 'tool_search')).toBe(true);
  });
});

describe('backfill of the BharatBank scope', () => {
  it('mirrors every record: class counts equal groundTruth.byClass exactly', async () => {
    const { c } = await setup();
    const { manifest, pulled } = await backfill(c);
    expect(pulled.inventory).toHaveLength(fx.groundTruth.records);
    expect(Object.keys(manifest.records)).toHaveLength(1683);
    expect(manifest.byClass).toEqual(fx.groundTruth.byClass);
    // Spot checks from the verified ground truth.
    expect(manifest.byClass).toMatchObject({
      sp_portal: 1, sp_page: 11, sp_widget: 18, sp_instance: 39, sp_container: 22, sys_db_object: 7, sys_dictionary: 112,
      sys_script: 12, sys_script_include: 2, sys_ui_action: 5, sys_security_acl: 26, sys_hub_flow: 10, sys_decision: 6,
      sys_ux_client_script: 14, sys_ux_screen: 5, sn_aia_agent: 1,
    });
    expect(manifest.byClass.sys_script_client).toBeUndefined();
    expect(manifest.byClass.sys_ui_policy).toBeUndefined();
  });

  it('fetches full records for every class, in pages of 200, with full script fields', async () => {
    const { c, m } = await setup();
    const { pulled } = await backfill(c);
    const classes = new Set(Object.keys(fx.groundTruth.byClass));
    const queried = new Set(m.calls.filter(x => x.tool === 'sn_query_table').map(x => String(x.args.table)));
    for (const cls of classes) expect(queried.has(cls), cls).toBe(true);
    const classCalls = m.calls.filter(x => x.tool === 'sn_query_table' && x.args.table !== 'sys_metadata' && x.args.table !== 'sys_scope');
    expect(classCalls.every(x => x.args.limit === 200 && x.args.truncate_output === false)).toBe(true);
    expect(classCalls.filter(x => x.args.table === 'sys_documentation').map(x => x.args.offset)).toEqual([0, 200]);
    // Every inventory record came back in full (the mock serves inventory fields for unrecorded classes).
    expect(pulled.full.size).toBe(1683);
    expect(pulled.failedClasses).toEqual([]);
  });

  it('only reads: every call is on the allowlist', async () => {
    const { c, m } = await setup();
    await backfill(c);
    await instanceInfo(c);
    expect(new Set(m.calls.map(x => x.inner ?? x.tool))).toEqual(new Set(['sn_query_table', 'sn_get_instance_info']));
  });

  it('writes the layout of the design doc, with sys_ids in every record path', async () => {
    const { c } = await setup();
    const { manifest, root, files } = await backfill(c);
    const ns = 'x_snc_cc_offering';
    const pathOf = (cls: string) => Object.values(manifest.records).filter(e => e.class === cls).map(e => e.path);
    expect(pathOf('sp_portal')).toEqual([`${ns}/portal/bharatbank-cc__5f0000000000000000000000000003ad/meta.json`]);
    expect(pathOf('sp_widget').every(p => /^x_snc_cc_offering\/widget\/[^/]+__[0-9a-f]{32}\/meta\.json$/.test(p))).toBe(true);
    expect(pathOf('sys_script').every(p => /^x_snc_cc_offering\/business_rule\/x_snc_cc_offering_[a-z_]+\/[^/]+__[0-9a-f]{32}\.js$/.test(p))).toBe(true);
    expect(pathOf('sys_script_include').every(p => /^x_snc_cc_offering\/script_include\/x_snc_cc_offering\.[A-Za-z]+__[0-9a-f]{32}\.js$/.test(p))).toBe(true);
    expect(new Set(pathOf('sys_dictionary').map(p => p.split('/')[1]))).toEqual(new Set(['schema']));
    expect(pathOf('sys_security_acl_role').every(p => p.includes('/acl/'))).toBe(true);
    expect(pathOf('sp_instance').every(p => p.endsWith('/layout.json'))).toBe(true);
    expect(pathOf('sys_ux_client_script').every(p => p.startsWith(`${ns}/workspace/sys_ux_client_script/`))).toBe(true);
    expect(pathOf('sn_aia_agent')[0]).toMatch(/^x_snc_cc_offering\/ai_agent\/[^/]+__[0-9a-f]{32}\/meta\.json$/);
    expect(pathOf('sys_documentation').every(p => p.startsWith(`${ns}/other/sys_documentation/`))).toBe(true);
    // Each manifest path exists on disk; widgets have their script files.
    for (const e of Object.values(manifest.records)) expect(fs.existsSync(path.join(root, ...e.path.split('/'))), e.path).toBe(true);
    const w = fx.tables.sp_widget.find(r => r.id === 'bb-dpdp-consent')!;
    const wdir = `${ns}/widget/bb-dpdp-consent__${w.sys_id}`;
    for (const f of ['template.html', 'client.js', 'server.js', 'link.js', 'style.scss', 'option_schema.json', 'meta.json']) expect(files.has(`${wdir}/${f}`), f).toBe(true);
    expect(read(root, `${wdir}/server.js`)).toBe(`${w.script}\n`);
    expect(JSON.parse(read(root, `${wdir}/meta.json`))).toMatchObject({ sys_id: w.sys_id, name: 'BB DPDP Consent', id: 'bb-dpdp-consent' });
  });

  it('puts business rule metadata in a header the analyzer can read', async () => {
    const { c } = await setup();
    const { manifest, root } = await backfill(c);
    const br = fx.tables.sys_script.find(r => r.name === 'CCO - Auto-create Ops Tasks')!;
    const text = read(root, manifest.records[br.sys_id].path);
    expect(readHeader(text)).toMatchObject({
      class: 'sys_script', sys_id: br.sys_id, table: 'x_snc_cc_offering_credit_card_application', when: 'after', order: 100,
      actions: ['insert', 'update'], active: false,
    });
    expect(text).toContain("new GlideRecord('x_snc_cc_offering_credit_card_ops_task')");
  });

  it('nests page layouts: containers, rows, columns and widget instances with resolved widget paths', async () => {
    const { c } = await setup();
    const { manifest, root } = await backfill(c);
    const pages = Object.values(manifest.records).filter(e => e.class === 'sp_page');
    let instances = 0;
    let resolved = 0;
    for (const p of pages) {
      const lay = JSON.parse(read(root, p.path.replace(/meta\.json$/, 'layout.json')));
      const walk = (rows: any[]) => { for (const r of rows) for (const col of r.columns) { for (const i of col.instances) { instances++; if (i.widget?.path) resolved++; } walk(col.rows); } };
      for (const ct of lay.containers) walk(ct.rows);
    }
    const inLayouts = Object.values(manifest.records).filter(e => e.class === 'sp_instance' && e.path.endsWith('layout.json')).length;
    expect(instances).toBe(inLayouts);
    expect(resolved).toBeGreaterThan(0);
  });

  it('builds table schemas from sys_db_object and sys_dictionary, with references', async () => {
    const { c } = await setup();
    const { root } = await backfill(c);
    const t = JSON.parse(read(root, 'x_snc_cc_offering/schema/x_snc_cc_offering_credit_card_application.sntable.json'));
    expect(t.table).toBe('x_snc_cc_offering_credit_card_application');
    expect(t.defined_here).toBe(true);
    expect(t.columns.find((x: any) => x.element === 'bureau_pull_date')).toMatchObject({ type: 'glide_date_time', label: 'Bureau Pull Date' });
    const total = fs.readdirSync(path.join(root, 'x_snc_cc_offering', 'schema')).length;
    expect(total).toBeGreaterThanOrEqual(7);
  });
});

describe('secrets and partial records', () => {
  it('never fetches credential classes and never writes secret fields', async () => {
    const { c, m } = await setup();
    const scope = await resolveScope(c, 'x_snc_cc_offering');
    const pulled = await pullScope(c, scope);
    const inventory = [...pulled.inventory,
      { sys_id: 'a'.repeat(32), sys_class_name: 'sys_auth_profile_basic', sys_name: 'Bureau API' },
      { sys_id: 'b'.repeat(32), sys_class_name: 'oauth_entity', sys_name: 'CMS OAuth' },
      { sys_id: 'c'.repeat(32), sys_class_name: 'discovery_credentials', sys_name: 'SSH' },
    ];
    const full = new Map(pulled.full);
    full.set('d'.repeat(32), { sys_id: 'd'.repeat(32), sys_class_name: 'sys_rest_message', name: 'Bureau', password: 'p', basic_auth_password: 'x', client_secret: 's', token_value: 't', endpoint: 'https://x' });
    inventory.push({ sys_id: 'd'.repeat(32), sys_class_name: 'sys_rest_message', sys_name: 'Bureau' });
    const { files, manifest } = layoutMirror({ instance: 'i', scope, inventory, full });
    expect(m.calls.some(x => /auth_profile|oauth_entity|discovery_credentials/.test(String(x.args.table)))).toBe(false);
    for (const id of ['a', 'b', 'c']) {
      const e = manifest.records[id.repeat(32)];
      expect(e.withheld).toBe(true);
      expect(JSON.parse(files.get(e.path)!)).toEqual({ sys_id: id.repeat(32), sys_class_name: e.class, sys_name: e.name, withheld: true });
    }
    const rest = JSON.parse(files.get(manifest.records['d'.repeat(32)].path)!);
    expect(rest).toEqual({ endpoint: 'https://x', name: 'Bureau', sys_class_name: 'sys_rest_message', sys_id: 'd'.repeat(32) });
    for (const text of files.values()) for (const k of Object.keys(safeParse(text))) expect(SECRET_FIELD.test(k), k).toBe(false);
  });

  it('never reads or writes a system property value', async () => {
    const { c, m } = await setup();
    const scope = await resolveScope(c, 'x_snc_cc_offering');
    await pullScope(c, scope);
    const props = m.calls.filter(x => x.args.table === 'sys_properties');
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) expect(p.args.fields).not.toContain('value');
    expect(clean({ sys_class_name: 'sys_properties', name: 'x.key', value: 'abc' })).toEqual({ name: 'x.key', sys_class_name: 'sys_properties' });
  });

  it('keeps inventory fields, marked partial, for a class whose query fails', async () => {
    const { c } = await setup({ failTables: ['sys_decision'] });
    const scope = await resolveScope(c, 'x_snc_cc_offering');
    const pulled = await pullScope(c, scope);
    expect(pulled.failedClasses.map(f => f.class)).toEqual(['sys_decision']);
    const { manifest, files } = layoutMirror({ instance: 'i', scope, ...pulled });
    expect(manifest.byClass).toEqual(fx.groundTruth.byClass);
    const decisions = Object.values(manifest.records).filter(e => e.class === 'sys_decision');
    expect(decisions).toHaveLength(6);
    expect(decisions.every(e => e.partial && JSON.parse(files.get(e.path)!).partial === true)).toBe(true);
  });
});

describe('reference fields as {link, value} (real nexus)', () => {
  it('pulls, mirrors and analyzes records whose reference fields are objects', async () => {
    const { c } = await setup();
    // The mock answers like real nexus: an ACL's operation is {link, value}, not a string.
    const raw = await c.call('sn_query_table', { table: 'sys_security_acl', query: `sys_scope=${fx.scope.sys_id}`, limit: 1 }) as { data: { records: Record<string, unknown>[] } };
    expect(raw.data.records[0].operation).toEqual({ link: expect.stringContaining('/'), value: expect.any(String) });
    expect(raw.data.records[0].sys_scope).toEqual({ link: expect.any(String), value: fx.scope.sys_id });

    const { root, manifest, files } = await backfill(c);
    expect(Object.keys(manifest.records)).toHaveLength(1683);
    expect(manifest.byClass).toEqual(fx.groundTruth.byClass);
    // ACL folders are named by operation value, and nothing anywhere reads "[object Object]".
    const ops = new Set(Object.values(manifest.records).filter(e => e.class === 'sys_security_acl').map(e => e.path.split('/')[2]));
    expect([...ops].every(o => /^[a-z_]+$/.test(o))).toBe(true);
    for (const [p, text] of files) {
      expect(p).not.toContain('object Object');
      expect(text, p).not.toContain('[object Object]');
      expect(text, p).not.toContain('"link"');
    }

    const model = new ProjectModel(root, { analyzers: [...ANALYZERS, serviceNowAnalyzer(root)] });
    await model.scan();
    const domain = buildDomainIndex(model.all(), p => model.content(p));
    const app = domain.tables.find(t => t.table === 'x_snc_cc_offering_credit_card_application')!;
    expect(app.rules?.filter(r => r.kind === 'acl').length).toBeGreaterThan(0);
    expect(app.rules?.filter(r => r.kind === 'business_rule').length).toBeGreaterThan(0);
  }, 60_000);
});

describe('mirror on disk', () => {
  it('is private (0700) and fits every path under the Windows limit', async () => {
    const { c } = await setup();
    const { root, manifest } = await backfill(c);
    expectMode(root, 0o700);
    expectMode(path.dirname(root), 0o700);
    for (const e of Object.values(manifest.records)) expect(root.length + 1 + e.path.length).toBeLessThanOrEqual(PATH_MAX);
    for (const rel of readManifest(root, 'x_snc_cc_offering')!.files) {
      for (const seg of rel.split('/')) {
        expect(seg, rel).not.toMatch(/[<>:"\\|?*]|[. ]$/);
        expect(seg, rel).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i);
      }
    }
  });

  it('writes nothing on a second identical pull, and moves a renamed record', async () => {
    const { c } = await setup();
    const first = await backfill(c);
    expect(first.res.written).toBeGreaterThan(0);
    const again = writeMirror(first.root, first.files, first.manifest);
    expect(again).toMatchObject({ written: 0, removed: 0 });
    // Rename one business rule: same sys_id, new name, so a new path; the old file goes.
    const br = fx.tables.sys_script[0];
    const full = new Map(first.pulled.full);
    full.set(br.sys_id, { ...full.get(br.sys_id)!, name: 'Renamed rule' });
    const { files, manifest } = layoutMirror({ instance: 'inmorphisdemo3', scope: first.scope, inventory: first.pulled.inventory, full, rootAbs: first.root });
    const res = writeMirror(first.root, files, manifest);
    expect(res.removed).toBe(1);
    expect(manifest.records[br.sys_id].path).toMatch(/\/Renamed rule__[0-9a-f]{32}\.js$/);
    expect(fs.existsSync(path.join(first.root, ...first.manifest.records[br.sys_id].path.split('/')))).toBe(false);
  });

  it('keeps its manifests out of the mirror with its own .gitignore', async () => {
    const { c } = await setup();
    const { root } = await backfill(c);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('*.manifest.json');
    expect(fs.existsSync(path.join(root, 'x_snc_cc_offering.manifest.json'))).toBe(true);
  });
});

describe('ensureGitignored', () => {
  it('does nothing outside a git repo', () => {
    expect(ensureGitignored(dir)).toBe('not-a-repo');
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });
  it('adds .livemap/ once inside a git repo, and keeps what was there', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
    expect(ensureGitignored(dir)).toBe('added');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.livemap/\n');
    expect(ensureGitignored(dir)).toBe('present');
  });
  it('works from a folder below the repo root', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    const sub = path.join(dir, 'apps', 'sn');
    fs.mkdirSync(sub, { recursive: true });
    expect(ensureGitignored(sub)).toBe('added');
    expect(fs.readFileSync(path.join(sub, '.gitignore'), 'utf8')).toBe('.livemap/\n');
  });
});

function safeParse(text: string): Record<string, unknown> {
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
