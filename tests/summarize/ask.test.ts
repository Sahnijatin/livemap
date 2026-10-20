import { describe, it, expect } from 'vitest';
import { buildAskContext, terms } from '../../src/summarize/ask.js';
import type { DomainIndex } from '../../src/shared/domain.js';
import type { FileModel } from '../../src/shared/types.js';

const sym = (name: string) => ({ name, qname: name, kind: 'function' as const, signature: `${name}()`, line: 1, endLine: 2, exported: true, hash: 'h', children: [] });
const file = (p: string, extra: Partial<FileModel> = {}): FileModel => ({
  path: p, lang: 'typescript', size: 10, lines: 3, symbols: [], imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {}, ...extra,
});
const domain: DomainIndex = { routes: [], tables: [], dataRefs: [], stack: [{ id: 'react', name: 'React', category: 'frontend', source: 'package.json' }], deps: [], scripts: [], env: [], counts: { routes: 0, pages: 0, screens: 0, tables: 0, deps: 0, env: 0 } };
const files = [
  file('src/auth/login.ts', { symbols: [sym('checkPassword')], imports: { local: ['src/db.ts'], external: ['bcrypt'] } }),
  file('src/db.ts', { symbols: [sym('query')] }),
  file('src/ui/button.tsx', { symbols: [sym('Button')] }),
  file('.env', { lang: 'secret', flags: { secret: true } }),
];
const src: Record<string, string> = { 'src/auth/login.ts': 'LOGIN SOURCE', 'src/db.ts': 'DB SOURCE', 'src/ui/button.tsx': 'BUTTON SOURCE', '.env': 'SECRET=1' };
const ctx = (question: string, focus?: string) =>
  buildAskContext({ name: 'demo', files, usedBy: [{ file: 'src/db.ts', symbol: 'query', usedIn: ['src/auth/login.ts'] }], domain, changes: [], question, ...(focus ? { focus } : {}), content: p => src[p] ?? null });

describe('ask context', () => {
  it('splits camelCase and drops filler words', () => {
    expect(terms('How does checkPassword work in the login flow?')).toEqual(['check', 'password', 'login', 'flow']);
  });

  it('includes the stack, the file index and the source of the files the question names', () => {
    const c = ctx('where is the password checked at login?');
    expect(c).toContain('Stack: React');
    expect(c).toContain('## Relevant: src/auth/login.ts');
    expect(c).toContain('LOGIN SOURCE');
    expect(c).not.toContain('BUTTON SOURCE');
    expect(c).toContain('src/ui/button.tsx: Button');
  });

  it('gives the focused file its source and connections both ways', () => {
    const c = ctx('what uses this?', 'src/db.ts');
    expect(c).toContain('## Focus: src/db.ts');
    expect(c).toContain('DB SOURCE');
    expect(c).toContain('imported by: src/auth/login.ts');
    expect(c).toContain('query used in: src/auth/login.ts');
  });

  it('never sends a secret file, even when it is the focus', () => {
    expect(ctx('env secret', '.env')).not.toContain('SECRET=1');
  });
});
