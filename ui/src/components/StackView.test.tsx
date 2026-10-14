// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DomainIndex } from '@shared/domain.js';
import { useStore } from '../store';
import { emptyDomain, file } from '../fixtures';
import { StackView } from './StackView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

// Values that exist in the fixture project's env files; none may ever render (the index carries names only).
const SECRET_VALUES = ['sk_live_123', 'postgres://user:pw@db/shop'];

function fixture(): DomainIndex {
  const d = emptyDomain();
  d.stack = [
    { id: 'nextjs', name: 'Next.js', category: 'frontend', source: 'package.json' },
    { id: 'prisma', name: 'Prisma', category: 'orm', source: 'package.json' },
    { id: 'typescript', name: 'TypeScript', category: 'language', source: 'files' },
  ];
  d.deps = [
    { name: 'next', version: '14.2.0', eco: 'npm', file: 'package.json', line: 6 },
    { name: 'zod', version: '^3.23.0', eco: 'npm', file: 'package.json' },
    { name: 'vitest', version: '^2.0.0', eco: 'npm', dev: true, file: 'package.json', line: 12 },
  ];
  d.scripts = [{ file: 'package.json', name: 'dev', command: 'next dev' }];
  d.env = [
    { name: 'DATABASE_URL', files: ['.env', '.env.example', 'lib/db.ts'], inExample: true, definedInEnvFile: true },
    { name: 'STRIPE_KEY', files: ['.env', 'lib/pay.ts'], inExample: false, definedInEnvFile: true },
  ];
  d.counts = { routes: 3, pages: 2, screens: 0, tables: 1, deps: 3, env: 2 };
  return d;
}

function mount(domain = fixture(), paths = ['package.json', '.env', '.env.example', 'lib/db.ts', 'lib/pay.ts', 'app/page.tsx']) {
  const files = paths.map(p => file(p, [], p.startsWith('.env') ? { lang: p === '.env' ? 'secret' : 'text', flags: p === '.env' ? { secret: true } : {} } as never : {}));
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], domain, indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] },
  });
  act(() => root.render(<StackView />));
}

const box = (title: string) => [...host.querySelectorAll<HTMLElement>('.box')].find(b => b.querySelector('h4')?.textContent?.startsWith(title))!;
const group = (label: string) => [...host.querySelectorAll<HTMLElement>('.tgroup')].find(g => g.querySelector('.tg-h')?.textContent === label);

beforeEach(() => {
  useStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('StackView', () => {
  it('groups detected techs by category', () => {
    mount();
    expect(group('Frontend')?.textContent).toContain('Next.js');
    expect(group('ORM')?.textContent).toContain('Prisma');
    expect(group('Language')?.textContent).toContain('TypeScript');
  });

  it('marks a tech first seen after hello as new', () => {
    mount();
    const d = fixture();
    d.stack = [...d.stack, { id: 'zod', name: 'Zod', category: 'tooling', source: 'package.json' }];
    act(() => useStore.getState().apply({ type: 'domain', domain: d }));
    const zod = [...host.querySelectorAll('.tech')].find(t => t.textContent?.includes('Zod'))!;
    expect(zod.classList.contains('new')).toBe(true);
    const next = [...host.querySelectorAll('.tech')].find(t => t.textContent?.includes('Next.js'))!;
    expect(next.classList.contains('new')).toBe(false);
  });

  it('lists deps under their manifest, and clicking one selects the manifest', () => {
    mount();
    const deps = box('Dependencies');
    const manifest = [...deps.querySelectorAll<HTMLElement>('.dgroup')].find(g => g.querySelector('.dg-h')?.textContent?.includes('package.json'))!;
    const zod = [...manifest.querySelectorAll<HTMLButtonElement>('.drow')].find(r => r.textContent?.includes('zod'))!;
    expect(zod.textContent).toContain('^3.23.0');
    act(() => zod.click());
    expect(useStore.getState().selected).toBe('package.json');
    // A dep with a line reveals it.
    const vitest = [...manifest.querySelectorAll<HTMLButtonElement>('.drow')].find(r => r.textContent?.includes('vitest'))!;
    expect(vitest.closest('.dsub')?.querySelector('.ds-h')?.textContent).toBe('Dev');
    act(() => vitest.click());
    expect(useStore.getState().reveal).toMatchObject({ path: 'package.json', line: 12 });
  });

  it('highlights a dep added since hello', () => {
    mount();
    const d = fixture();
    d.deps = [...d.deps, { name: 'stripe', version: '^14.0.0', eco: 'npm', file: 'package.json', line: 9 }];
    act(() => useStore.getState().apply({ type: 'domain', domain: d }));
    const rows = [...box('Dependencies').querySelectorAll('.drow')];
    expect(rows.find(r => r.textContent?.includes('stripe'))!.classList.contains('new')).toBe(true);
    expect(rows.find(r => r.textContent?.includes('zod'))!.classList.contains('new')).toBe(false);
  });

  it('lists scripts with their command', () => {
    mount();
    const row = box('Scripts').querySelector('.drow')!;
    expect(row.textContent).toContain('dev');
    expect(row.textContent).toContain('next dev');
  });

  it('flags env vars used in code but missing from .env.example, and shows only names', () => {
    mount();
    const env = box('Environment');
    const stripe = [...env.querySelectorAll<HTMLElement>('.erow')].find(r => r.querySelector('.en')?.textContent === 'STRIPE_KEY')!;
    expect(stripe.textContent).toContain('Missing from .env.example');
    expect(stripe.textContent).toContain('lib/pay.ts');
    expect(stripe.textContent).toContain('Defined in .env');
    const db = [...env.querySelectorAll<HTMLElement>('.erow')].find(r => r.querySelector('.en')?.textContent === 'DATABASE_URL')!;
    expect(db.textContent).toContain('In .env.example');
    expect(db.textContent).not.toContain('Missing');
    const text = host.textContent ?? '';
    for (const v of SECRET_VALUES) expect(text).not.toContain(v);
    expect(text).not.toMatch(/[A-Z_]+=/);
    // Clicking a using file selects it.
    const link = [...stripe.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'lib/pay.ts')!;
    act(() => link.click());
    expect(useStore.getState().selected).toBe('lib/pay.ts');
  });

  it('says nothing about examples when the project has no .env.example', () => {
    const d = fixture();
    d.env = d.env.map(v => ({ ...v, inExample: false, files: v.files.filter(f => f !== '.env.example') }));
    mount(d, ['package.json', '.env', 'lib/db.ts', 'lib/pay.ts']);
    const env = box('Environment');
    expect(env.textContent).not.toContain('.env.example');
  });

  it('shows counts in What exists', () => {
    mount();
    const bars = box('What exists');
    const label = (l: string) => [...bars.querySelectorAll('.bar')].find(b => b.querySelector('span')?.textContent === l);
    expect(label('Routes')?.querySelector('b')?.textContent).toBe('3');
    expect(label('Pages')?.querySelector('b')?.textContent).toBe('2');
    expect(label('Dependencies')?.querySelector('b')?.textContent).toBe('3');
    expect(label('Screens')).toBeUndefined();
  });

  it('renders two same-name deps from one manifest without key clashes', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = fixture();
    d.deps = [
      { name: 'numpy', version: '==1.24', eco: 'pypi', file: 'requirements.txt', line: 3 },
      { name: 'numpy', version: '==1.26', eco: 'pypi', file: 'requirements.txt', line: 4 },
    ];
    mount(d);
    const rows = [...box('Dependencies').querySelectorAll('.drow')];
    expect(rows.map(r => r.textContent)).toEqual(['numpy==1.24', 'numpy==1.26']);
    expect(err.mock.calls.some(c => String(c[0]).includes('same key'))).toBe(false);
    err.mockRestore();
  });
});
