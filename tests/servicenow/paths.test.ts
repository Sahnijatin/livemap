import { describe, it, expect } from 'vitest';
import { fitPath, NAME_MAX, PATH_MAX, recordSegment, safeSegment } from '../../plugins/servicenow/paths.js';

const ID = '5f00000000000000000000000000005f';

describe('safeSegment (Windows-safe names)', () => {
  it('replaces characters Windows forbids and control characters', () => {
    expect(safeSegment('a:b/c\\d?e*f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeSegment('tab\there\u0001x')).toBe('tab_here_x');
  });
  it('strips trailing dots and spaces, and leading spaces', () => {
    expect(safeSegment(' Credit Card Document')).toBe('Credit Card Document');
    expect(safeSegment('Credit Card PB ')).toBe('Credit Card PB');
    expect(safeSegment('name...')).toBe('name');
    expect(safeSegment('a . . ')).toBe('a');
  });
  it('prefixes reserved device names, with or without an extension, in any case', () => {
    for (const n of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.txt', 'nul.json']) expect(safeSegment(n), n).toBe(`_${n}`);
    for (const n of ['CONSOLE', 'COM10', 'LPT', 'nullable', 'aux_table']) expect(safeSegment(n), n).toBe(n);
  });
  it('turns empty and dot-only names into _', () => {
    for (const n of ['', '   ', '.', '..', '...']) expect(safeSegment(n), JSON.stringify(n)).toBe('_');
  });
});

describe('recordSegment', () => {
  it('is <name>__<sys_id><ext>', () => {
    expect(recordSegment('CCO - Auto-create Ops Tasks', ID, '.js')).toBe(`CCO - Auto-create Ops Tasks__${ID}.js`);
    expect(recordSegment('x_snc.Utils', ID, '.js')).toBe(`x_snc.Utils__${ID}.js`);
  });
  it('keeps only the sys_id when there is no usable name', () => {
    expect(recordSegment('', ID, '.json')).toBe(`${ID}.json`);
    expect(recordSegment('...', ID)).toBe(ID);
    expect(recordSegment(undefined, ID)).toBe(ID);
  });
  it(`cuts the name to ${NAME_MAX} characters and keeps the sys_id`, () => {
    const s = recordSegment('x'.repeat(200), ID, '.js');
    expect(s).toBe(`${'x'.repeat(NAME_MAX)}__${ID}.js`);
  });
  it('never ends the name part in a dot or space after cutting, and never splits a surrogate pair', () => {
    expect(recordSegment(`${'a'.repeat(NAME_MAX - 1)} b`, ID)).toBe(`${'a'.repeat(NAME_MAX - 1)}__${ID}`);
    const emoji = recordSegment(`${'a'.repeat(NAME_MAX - 1)}😀`, ID);
    expect(emoji).toBe(`${'a'.repeat(NAME_MAX - 1)}__${ID}`);
  });
  it('rejects a value that is not a sys_id', () => {
    expect(() => recordSegment('a', '../../etc')).toThrow();
  });
});

describe('non-string names', () => {
  it('fail with an error naming the field, not a TypeError from inside', () => {
    const ref = { link: 'https://i.service-now.com/api/now/table/sys_security_operation/create', value: 'create' };
    expect(() => safeSegment(ref as unknown as string, 'operation')).toThrow(/^operation must be a string to name a mirror path, got object: \{"link"/);
    expect(() => safeSegment(null as unknown as string, 'table')).toThrow(/table must be a string.*got null/);
    expect(() => recordSegment(42 as unknown as string, ID, '.js', 'api_name')).toThrow(/api_name must be a string.*got number: 42/);
    expect(() => recordSegment('x', ref as unknown as string)).toThrow(/sys_id must be a string/);
    expect(recordSegment(undefined, ID, '.js')).toBe(`${ID}.js`);
  });
});

describe('fitPath', () => {
  const rel = `x_snc_cc_offering/business_rule/x_snc_cc_offering_credit_card_application/${'N'.repeat(NAME_MAX)}__${ID}.js`;
  it('leaves a path that fits unchanged', () => {
    expect(fitPath('C:\\Users\\jatin\\proj\\.livemap\\sn', rel)).toBe(rel);
  });
  it(`shortens the name part, keeps the sys_id, and fits under ${PATH_MAX} characters`, () => {
    const root = 'C:\\Users\\' + 'u'.repeat(80) + '\\.livemap\\sn';
    const out = fitPath(root, rel);
    expect(root.length + 1 + out.length).toBeLessThanOrEqual(PATH_MAX);
    expect(out.endsWith(`__${ID}.js`)).toBe(true);
    expect(out.startsWith('x_snc_cc_offering/business_rule/x_snc_cc_offering_credit_card_application/N')).toBe(true);
  });
  it('drops the name entirely when it must, and fails only when nameless segments cannot fit', () => {
    const root = 'C:\\' + 'd'.repeat(125);
    const out = fitPath(root, rel);
    expect(out).toBe(`x_snc_cc_offering/business_rule/x_snc_cc_offering_credit_card_application/${ID}.js`);
    expect(() => fitPath('C:\\' + 'd'.repeat(200), rel)).toThrow(/too long/);
  });
});
