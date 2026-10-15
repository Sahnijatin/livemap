// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_GRAMMARS_ID, type ExportGrammars } from '@shared/export.js';
import { grammarId, HIGHLIGHTED } from '@shared/grammars.js';

const wasm = async (): Promise<string> => Buffer.from((await import('shiki/wasm')).wasmBinary).toString('base64');

/** The highlight module as built for `mode`, fresh, so it reads the page again. */
async function load(mode: string): Promise<typeof import('./highlight')> {
  vi.resetModules();
  vi.stubEnv('MODE', mode);
  return import('./highlight');
}

function embed(g: ExportGrammars): void {
  const el = document.createElement('script');
  el.type = 'application/json';
  el.id = EXPORT_GRAMMARS_ID;
  el.textContent = JSON.stringify(g);
  document.body.append(el);
}

afterEach(() => {
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
});

describe('grammarId', () => {
  it('maps languages to Shiki grammars, and .jsx files to jsx', () => {
    expect(grammarId('typescript', 'a.ts')).toBe('typescript');
    expect(grammarId('shell', 'run.sh')).toBe('shellscript');
    expect(grammarId('javascript', 'App.jsx')).toBe('jsx');
  });
});

describe('highlight in an export (#17)', () => {
  it('highlights with the grammars and the engine the page embeds', async () => {
    const ts = (await import('shiki/langs/typescript.mjs')).default as ExportGrammars['langs'];
    embed({ langs: ts, wasm: await wasm() });
    const { highlight } = await load('export');
    const tokens = await highlight('const a = 1;', 'typescript', 'a.ts');
    expect(tokens?.[0].map(t => t.content).join('')).toBe('const a = 1;');
    expect(tokens![0].length).toBeGreaterThan(1);
    // A language the page does not embed shows plain text.
    expect(await highlight('x = 1', 'python', 'b.py')).toBeNull();
  });

  it('shows plain text when the page embeds no grammars (--no-code)', async () => {
    const { highlight } = await load('export');
    expect(await highlight('const a = 1;', 'typescript', 'a.ts')).toBeNull();
  });
});

describe('highlight in the live app', () => {
  it('highlights every language in HIGHLIGHTED, and not plain text', async () => {
    const { highlight } = await load('production');
    for (const lang of HIGHLIGHTED) expect(await highlight('x', lang, 'f'), lang).not.toBeNull();
    expect(await highlight('x', 'text', 'notes.txt')).toBeNull();
  });

  it('loads a grammar on first use', async () => {
    const { highlight } = await load('production');
    const tokens = await highlight('const a = <b />;', 'javascript', 'App.jsx');
    expect(tokens?.[0].map(t => t.content).join('')).toBe('const a = <b />;');
    expect(tokens![0].length).toBeGreaterThan(1);
  });
});
