import { describe, it, expect } from 'vitest';
import { detectStack } from '../../../src/engine/domain/stack.js';
import type { Dep, FileModel, Lang } from '../../../src/shared/types.js';

const fm = (path: string, lang: Lang = 'other'): FileModel => ({
  path, lang, size: 1, lines: 1, symbols: [], imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
});
const d = (name: string, eco: string, file: string, dev = false): Dep & { file: string } => ({ name, version: '1', eco, file, ...(dev ? { dev: true } : {}) });

describe('detectStack', () => {
  it('maps npm, pypi and go deps to techs with categories and sources', () => {
    const deps = [
      d('next', 'npm', 'web/package.json'), d('react', 'npm', 'web/package.json'), d('@prisma/client', 'npm', 'web/package.json'),
      d('prisma', 'npm', 'web/package.json', true), d('tailwindcss', 'npm', 'web/package.json', true), d('@playwright/test', 'npm', 'web/package.json', true),
      d('@anthropic-ai/sdk', 'npm', 'web/package.json'), d('ai', 'npm', 'web/package.json'), d('@sveltejs/kit', 'npm', 'web/package.json'),
      d('@nestjs/core', 'npm', 'web/package.json'), d('drizzle-orm', 'npm', 'web/package.json'), d('@supabase/supabase-js', 'npm', 'web/package.json'),
      d('FastAPI', 'pypi', 'api/requirements.txt'), d('SQLAlchemy', 'pypi', 'api/requirements.txt'), d('psycopg2-binary', 'pypi', 'api/requirements.txt'),
      d('pytest', 'pypi', 'api/requirements.txt'), d('anthropic', 'pypi', 'api/requirements.txt'),
      d('github.com/gin-gonic/gin', 'go', 'svc/go.mod'), d('github.com/go-chi/chi/v5', 'go', 'svc/go.mod'),
      d('org.springframework.boot:spring-boot-starter-web', 'maven', 'jvm/build.gradle'), d('androidx.room:room-runtime', 'maven', 'jvm/build.gradle'),
      d('flutter', 'pub', 'app/pubspec.yaml'), d('laravel/framework', 'composer', 'php/composer.json'),
      d('left-pad', 'npm', 'web/package.json'),
    ];
    const stack = detectStack(deps, []);
    const by = Object.fromEntries(stack.map(t => [t.id, t]));
    expect(by.next).toEqual({ id: 'next', name: 'Next.js', category: 'frontend', source: 'web/package.json' });
    expect(by.react).toMatchObject({ name: 'React', category: 'frontend' });
    expect(by.sveltekit).toMatchObject({ name: 'SvelteKit', category: 'frontend' });
    expect(by.nestjs).toMatchObject({ name: 'NestJS', category: 'backend' });
    expect(by.prisma).toMatchObject({ name: 'Prisma', category: 'orm', source: 'web/package.json' });
    expect(by.drizzle).toMatchObject({ name: 'Drizzle', category: 'orm' });
    expect(by.tailwindcss).toMatchObject({ name: 'Tailwind CSS', category: 'styling' });
    expect(by.playwright).toMatchObject({ category: 'testing' });
    expect(by.anthropic).toMatchObject({ category: 'ai', source: 'api/requirements.txt' });
    expect(by.ai).toMatchObject({ name: 'Vercel AI SDK', category: 'ai' });
    expect(by.supabase).toMatchObject({ name: 'Supabase', category: 'database' });
    expect(by.fastapi).toEqual({ id: 'fastapi', name: 'FastAPI', category: 'backend', source: 'api/requirements.txt' });
    expect(by.sqlalchemy).toMatchObject({ category: 'orm' });
    expect(by.psycopg).toMatchObject({ category: 'database' });
    expect(by.pytest).toMatchObject({ category: 'testing' });
    expect(by.gin).toMatchObject({ category: 'backend', source: 'svc/go.mod' });
    expect(by.chi).toMatchObject({ category: 'backend' });
    expect(by.spring).toMatchObject({ category: 'backend' });
    expect(by.room).toMatchObject({ category: 'orm' });
    expect(by.flutter).toMatchObject({ category: 'mobile' });
    expect(by.laravel).toMatchObject({ category: 'backend' });
    expect(stack.filter(t => t.id === 'prisma')).toHaveLength(1);
    expect(stack.filter(t => t.id === 'anthropic')).toHaveLength(1);
    expect(stack.some(t => t.id === 'left-pad')).toBe(false);
  });

  it('detects docker from a Dockerfile', () => {
    expect(detectStack([], [fm('Dockerfile')])).toEqual([{ id: 'docker', name: 'Docker', category: 'tooling', source: 'files' }]);
    expect(detectStack([], [fm('api/Dockerfile.dev')]).map(t => t.id)).toEqual(['docker']);
    expect(detectStack([], [fm('docs/Dockerfile.md', 'markdown')])).toEqual([]);
  });

  it('lists a language at 3 or more files, or at 10% of code files', () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => fm(`src/f${i}.ts`, 'typescript')),
      fm('src/a.tsx', 'tsx'),
      fm('s1.py', 'python'), fm('s2.py', 'python'),
      fm('main.go', 'go'),
      fm('README.md', 'markdown'), fm('a.json', 'json'), fm('b.json', 'json'), fm('c.json', 'json'),
    ];
    const langs = detectStack([], files).filter(t => t.category === 'language');
    expect(langs).toEqual([{ id: 'typescript', name: 'TypeScript', category: 'language', source: 'files' }]);
    const small = [fm('a.go', 'go'), fm('b.go', 'go'), fm('x.rs', 'rust')];
    expect(detectStack([], small).map(t => t.id)).toEqual(['go', 'rust']);
    expect(detectStack([], [...small, fm('c.go', 'go'), fm('y.rs', 'rust'), fm('z.rs', 'rust')]).map(t => t.id)).toEqual(['go', 'rust']);
  });

  it('orders techs by category, then name', () => {
    const stack = detectStack([d('vitest', 'npm', 'package.json'), d('express', 'npm', 'package.json'), d('react', 'npm', 'package.json'), d('typescript', 'npm', 'package.json')], []);
    expect(stack.map(t => t.category)).toEqual(['frontend', 'backend', 'testing', 'tooling']);
  });

  it('keeps ids unique: a detected language replaces the typescript tooling dep', () => {
    const files = [fm('a.ts', 'typescript'), fm('b.ts', 'typescript'), fm('c.ts', 'typescript')];
    expect(detectStack([d('typescript', 'npm', 'package.json', true)], files)).toEqual([{ id: 'typescript', name: 'TypeScript', category: 'language', source: 'files' }]);
  });
});
