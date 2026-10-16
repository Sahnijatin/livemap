import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullScope, resolveScope } from '../../plugins/servicenow/backfill.js';
import { layoutMirror, scriptFile } from '../../plugins/servicenow/mirror.js';
import { NexusClient } from '../../plugins/servicenow/nexus.js';
import { snRoot, writeMirror } from '../../plugins/servicenow/writer.js';
import { serviceNowAnalyzer } from '../../plugins/servicenow/analyzer.js';
import { ProjectModel } from '../../src/engine/project.js';
import { ANALYZERS } from '../../src/engine/domain/index.js';
import { buildDomainIndex } from '../../src/engine/domain/build-index.js';
import type { FileModel } from '../../src/shared/types.js';
import type { DomainIndex } from '../../src/shared/domain.js';
import { rmTree } from '../helpers/platform.js';
import { loadFixture, startMockNexus } from '../helpers/mock-nexus.js';

const fx = loadFixture();
const NS = 'x_snc_cc_offering';
let dir: string;
let root: string;
let model: ProjectModel;
let domain: DomainIndex;
let paths: Record<string, string>;

beforeAll(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sna-')));
  const m = await startMockNexus();
  const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3' });
  try {
    const scope = await resolveScope(c, NS);
    const pulled = await pullScope(c, scope);
    root = snRoot(dir);
    const { files, manifest } = layoutMirror({ instance: 'inmorphisdemo3', scope, ...pulled, rootAbs: root });
    writeMirror(root, files, manifest);
    paths = Object.fromEntries(Object.entries(manifest.records).map(([id, e]) => [id, e.path]));
  } finally {
    await c.close();
    await m.close();
  }
  model = new ProjectModel(root, { analyzers: [...ANALYZERS, serviceNowAnalyzer(root)] });
  await model.scan();
  domain = buildDomainIndex(model.all(), p => model.content(p));
}, 60_000);
afterAll(() => rmTree(dir));

const file = (p: string): FileModel => {
  const f = model.get(p);
  if (!f) throw new Error(`not indexed: ${p}`);
  return f;
};
const byClass = (cls: string) => fx.tables[cls as 'sp_widget'] as Record<string, string>[];

describe('ServiceNow analyzer on the BharatBank mirror', () => {
  it('indexes the mirror, not its manifest', () => {
    expect(model.all().length).toBeGreaterThan(300);
    expect(model.get(`${NS}.manifest.json`)).toBeUndefined();
  });

  it('turns tables into entities with reference columns as foreign keys', () => {
    const app = domain.tables.find(t => t.table === 'x_snc_cc_offering_credit_card_application');
    expect(app?.orm).toBe('servicenow');
    expect(app?.fields.find(f => f.name === 'sys_id')?.pk).toBe(true);
    expect(app?.fields.find(f => f.name === 'bureau_pull_date')?.type).toBe('glide_date_time');
    const refs = byClass('sys_dictionary').filter(d => d.reference && d.name === 'x_snc_cc_offering_credit_card_application');
    for (const d of refs) expect(app?.fields.find(f => f.name === d.element)?.fk, d.element).toEqual({ table: d.reference, field: 'sys_id' });
    const defined = byClass('sys_db_object').map(t => t.name);
    for (const t of defined) expect(domain.tables.some(x => x.table === t), t).toBe(true);
  });

  it('turns portal pages into page routes under the portal suffix', () => {
    const pages = domain.routes.filter(r => r.kind === 'page' && r.framework === 'servicenow');
    expect(pages).toHaveLength(11);
    expect(pages.map(r => r.path)).toContain('/bharatbank-cc?id=cc_home');
    expect(domain.routes.filter(r => r.kind === 'screen' && r.framework === 'servicenow')).toHaveLength(5);
  });

  it('gives a script include its class and methods as symbols', () => {
    const si = byClass('sys_script_include').find(s => s.name === 'BBPortalFormatUtils')!;
    const [cls] = file(paths[si.sys_id]).symbols;
    expect(cls).toMatchObject({ name: 'BBPortalFormatUtils', kind: 'class' });
    expect(cls.children.map(c => c.name)).toEqual(['initialize', 'formatInr', 'getPurposeLabel', 'getArtClass', 'getMaskedNumber']);
    expect(cls.children[1]).toMatchObject({ qname: 'BBPortalFormatUtils.formatInr', kind: 'method', signature: 'formatInr()' });
  });

  it('gives a business rule one symbol with signature table.when(condition), and a Rule on its table', () => {
    const br = byClass('sys_script').find(r => r.name === 'CCO - Auto-create Ops Tasks')!;
    const f = file(paths[br.sys_id]);
    expect(f.symbols).toHaveLength(1);
    expect(f.symbols[0]).toMatchObject({ name: br.name, kind: 'function', signature: 'x_snc_cc_offering_credit_card_application.after(stageVALCHANGES^EQ)' });
    expect(f.rules).toEqual([expect.objectContaining({ kind: 'business_rule', table: br.collection, when: 'after', order: 100, actions: ['insert', 'update'], active: false })]);
  });

  it('lists rules on each table in firing order: ACLs, then business rules by when and order', () => {
    const app = domain.tables.find(t => t.table === 'x_snc_cc_offering_credit_card_application')!;
    const brs = byClass('sys_script').filter(r => r.collection === app.table);
    const acls = byClass('sys_security_acl').filter(a => a.name.split('.')[0] === app.table);
    const rules = app.rules ?? [];
    expect(rules.filter(r => r.kind === 'business_rule')).toHaveLength(brs.length);
    expect(rules.filter(r => r.kind === 'acl')).toHaveLength(acls.length);
    const kinds = rules.map(r => r.kind);
    expect(kinds.lastIndexOf('acl')).toBeLessThan(kinds.indexOf('business_rule'));
    const b = rules.filter(r => r.kind === 'business_rule');
    for (let i = 1; i < b.length; i++) {
      const [x, y] = [b[i - 1], b[i]];
      expect((x.when ?? '') < (y.when ?? '') || ((x.when ?? '') === (y.when ?? '') && (x.order ?? 0) <= (y.order ?? 0))).toBe(true);
    }
  });

  it('links portal to its home page, page to the widgets it places, widget to widgets and tables', () => {
    const portal = Object.values(paths).find(p => p.includes('/portal/'))!;
    const home = Object.values(paths).find(p => /\/page\/cc_home__/.test(p))!;
    expect(file(portal).imports.local).toContain(home);
    // Every page layout links the in-scope widgets its instances place.
    let placed = 0;
    for (const p of new Set(Object.values(paths).filter(x => x.endsWith('/layout.json')))) {
      const lay = JSON.parse(model.content(p)!);
      const want = new Set<string>();
      const walk = (rows: any[]) => { for (const r of rows) for (const c of r.columns) { for (const i of c.instances) if (i.widget?.path) want.add(i.widget.path); walk(c.rows); } };
      for (const ct of lay.containers) walk(ct.rows);
      for (const w of want) expect(file(p).imports.local, p).toContain(w);
      placed += want.size;
    }
    expect(placed).toBeGreaterThan(0);
    // bb-application-form embeds bb-card-visual and bb-loading-screen with $sp.getWidget, and writes tables.
    const form = byClass('sp_widget').find(w => w.id === 'bb-application-form')!;
    const dirOf = (id: string) => path.posix.dirname(paths[byClass('sp_widget').find(w => w.id === id)!.sys_id]);
    const links = new Set([...(model.get(`${dirOf('bb-application-form')}/server.js`)?.imports.local ?? []), ...(model.get(`${dirOf('bb-application-form')}/client.js`)?.imports.local ?? [])]);
    expect(links).toContain(`${dirOf('bb-card-visual')}/meta.json`);
    expect(links).toContain(`${dirOf('bb-loading-screen')}/meta.json`);
    const tables = [...(form.script + form.client_script).matchAll(/new GlideRecord\('(\w+)'\)/g)].map(m => m[1]);
    for (const t of tables) if (model.get(`${NS}/schema/${t}.sntable.json`)) expect(links).toContain(`${NS}/schema/${t}.sntable.json`);
  });

  it('links a business rule and an ACL to their table', () => {
    const br = byClass('sys_script').find(r => r.name === 'CCO - Auto-create Ops Tasks')!;
    expect(file(paths[br.sys_id]).imports.local).toContain(`${NS}/schema/${br.collection}.sntable.json`);
    const acl = byClass('sys_security_acl').find(a => a.name === 'x_snc_cc_offering_document')!;
    expect(file(paths[acl.sys_id]).imports.local).toEqual([`${NS}/schema/x_snc_cc_offering_document.sntable.json`]);
  });

  it('links new X(), gs.include and GlideAjax to the script include they name (synthetic: the fixture has no callers)', async () => {
    const si = byClass('sys_script_include').find(s => s.name === 'BBPortalFormatUtils')!;
    const target = paths[si.sys_id];
    const extra = `${NS}/business_rule/x_snc_cc_offering_credit_card_application/Uses utils__${'e'.repeat(32)}.js`;
    fs.mkdirSync(path.dirname(path.join(root, extra)), { recursive: true });
    fs.writeFileSync(path.join(root, extra), scriptFile({ class: 'sys_script', name: 'Uses utils', table: 'x_snc_cc_offering_credit_card_application', when: 'before' },
      "var u = new BBPortalFormatUtils();\ngs.include('x_snc_cc_offering.MockIntegrationService');\nvar ga = new GlideAjax('x_snc_cc_offering.BBPortalFormatUtils');\n"));
    try {
      await model.update(extra, 'add');
      const mock = paths[byClass('sys_script_include').find(s => s.name === 'MockIntegrationService')!.sys_id];
      expect(file(extra).imports.local).toEqual([target, mock, `${NS}/schema/x_snc_cc_offering_credit_card_application.sntable.json`].sort());
    } finally {
      fs.rmSync(path.join(root, extra));
      await model.update(extra, 'unlink');
    }
  });

  it('links a scope-qualified new x_scope.X() and a string literal naming a scope table, and nothing else', async () => {
    const target = paths[byClass('sys_script_include').find(s => s.name === 'BBPortalFormatUtils')!.sys_id];
    const extra = `${NS}/script_include/Caller__${'f'.repeat(32)}.js`;
    fs.writeFileSync(path.join(root, extra), scriptFile({ class: 'sys_script_include', name: 'Caller' },
      "var fmt = new x_snc_cc_offering.BBPortalFormatUtils();\nvar t = options.table_name || 'x_snc_cc_offering_document';\n" +
      "var gr = new GlideRecordSecure(t);\nvar other = new global.NotMirrored();\nvar s = 'not_a_table' + \"x_snc_cc_offering_nope\";\n"));
    try {
      await model.update(extra, 'add');
      expect(file(extra).imports.local).toEqual([target, `${NS}/schema/x_snc_cc_offering_document.sntable.json`].sort());
    } finally {
      fs.rmSync(path.join(root, extra));
      await model.update(extra, 'unlink');
    }
  });
});
