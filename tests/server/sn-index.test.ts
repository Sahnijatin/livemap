import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSnIndex } from '../../src/server/sn-index.js';

let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

const id = (n: number) => `5f${String(n).padStart(30, '0')}`;
function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

describe('readSnIndex', () => {
  it('is null for a folder with no scope manifest', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-snidx-'));
    put('src/a.ts', 'export {}\n');
    expect(await readSnIndex(dir)).toBeNull();
    expect(await readSnIndex(path.join(dir, 'missing'))).toBeNull();
  });

  it('reads folder, script and JSON records, and only the fields the UI shows', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-snidx-'));
    const widget = `x_app/widget/carousel__${id(1)}`;
    const rule = `x_app/business_rule/task/Rule__${id(2)}.js`;
    const prop = `x_app/other/sys_properties/x_app.key__${id(3)}.json`;
    const table = 'x_app/schema/x_app_task.sntable.json';
    put(`${widget}/meta.json`, JSON.stringify({ name: 'Carousel', sys_updated_by: 'admin', sys_updated_on: '2026-06-13 10:18:00', sys_update_set: { value: id(9), display_value: 'Card refresh' } }));
    put(`${widget}/server.js`, '// server\n');
    put(rule, `// @livemap-sn {"class":"sys_script","sys_id":"${id(2)}","updatedBy":"dev.user1","updateSetName":"Rules"}\n(function () {})();\n`);
    put(prop, JSON.stringify({ name: 'x_app.key', value: 'do-not-send', sys_updated_by: 'admin' }));
    put(table, JSON.stringify({ table: 'x_app_task', columns: [] }));
    put('x_app.manifest.json', JSON.stringify({
      version: 1, instance: 'acme', scope: { scope: 'x_app', name: 'App', sys_id: id(100) },
      records: {
        [id(1)]: { class: 'sp_widget', name: 'Carousel', path: `${widget}/meta.json` },
        [id(2)]: { class: 'sys_script', name: 'Rule', path: rule },
        [id(3)]: { class: 'sys_properties', name: 'x_app.key', path: prop },
        [id(4)]: { class: 'sys_dictionary', name: 'Number', path: table },
        [id(5)]: { class: 'sys_db_object', name: ' Task', path: table },
        [id(6)]: { class: 'sp_widget', name: 'Escape', path: '../outside/meta.json' },
      },
    }));
    const index = (await readSnIndex(dir))!;
    expect(index.instance).toBe('acme');
    expect(index.scopes).toEqual([{ scope: 'x_app', name: 'App', sysId: id(100) }]);
    const by = new Map(index.records.map(r => [r.path, r]));
    expect(by.get(widget)).toEqual({ path: widget, dir: true, sysId: id(1), table: 'sp_widget', name: 'Carousel', scope: 'x_app', updateSet: id(9), updateSetName: 'Card refresh', updatedBy: 'admin', updatedOn: '2026-06-13 10:18:00' });
    expect(by.get(rule)).toMatchObject({ dir: false, table: 'sys_script', updatedBy: 'dev.user1', updateSetName: 'Rules' });
    // A table and its dictionary entries share one file: it is the table's.
    expect(by.get(table)).toMatchObject({ table: 'sys_db_object', name: 'Task', sysId: id(5) });
    // A path that leaves the mirror is skipped; a property's value is never read out.
    expect(index.records).toHaveLength(4);
    expect(JSON.stringify(index)).not.toContain('do-not-send');
  });
});
