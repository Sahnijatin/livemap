import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { screens } from '../../../src/engine/domain/screens.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/screens/', import.meta.url));
const run = (rel: string, text: string) => analyzeFile(rel, langOf(rel), text, [screens]).routes;

describe('screens analyzer', () => {
  for (const fw of ['expo', 'react-navigation', 'gorouter']) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, fw, 'expected.json'), 'utf8')) as Record<string, unknown>;
    for (const [rel, want] of Object.entries(golden)) {
      it(`${fw}: ${rel} matches the golden`, () => {
        expect(run(rel, fs.readFileSync(path.join(DIR, fw, rel), 'utf8'))).toEqual(want);
      });
    }
  }

  it('is registered and gated to JS, TS and Dart', () => {
    expect(ANALYZERS).toContain(screens);
    expect(screens.applies('src/App.tsx', 'tsx')).toBe(true);
    expect(screens.applies('src/App.js', 'javascript')).toBe(true);
    expect(screens.applies('src/nav.ts', 'typescript')).toBe(true);
    expect(screens.applies('lib/router.dart', 'dart')).toBe(true);
    expect(screens.applies('app.py', 'python')).toBe(false);
  });

  it('leaves Next.js pages under app/ to routes-js', () => {
    expect(run('app/orders/page.tsx', "import { useRouter } from 'expo-router';\nexport default function P() {}\n")).toEqual([]);
    const all = analyzeFile('app/orders/page.tsx', 'tsx', 'export default function P() {}\n');
    expect(all.routes.map(r => r.framework)).toEqual(['next']);
  });

  it('maps a nested Expo index to its folder and a root index to /', () => {
    const src = "import { router } from 'expo-router';\nexport default function S() {}\n";
    expect(run('apps/mobile/app/(auth)/login/index.tsx', src).map(r => r.path)).toEqual(['/login']);
    expect(run('app/index.tsx', src).map(r => r.path)).toEqual(['/']);
    expect(run('app/[...rest].tsx', src).map(r => r.path)).toEqual(['/:rest*']);
    expect(run('app/orders+api.ts', src)).toEqual([]);
  });

  it('uses the app folder nearest the file', () => {
    expect(run('app/mobile/app/orders.tsx', "import { router } from 'expo-router';\nexport default function O() {}\n").map(r => r.path)).toEqual(['/orders']);
  });

  it('joins nested GoRouter paths across a parent longer than 10 KB', () => {
    const kids = Array.from({ length: 300 }, (_, i) => `        GoRoute(path: 'c${i}', builder: (c, s) => Child${i}()),\n`).join('');
    const src = "final router = GoRouter(routes: [\n  GoRoute(path: '/p', builder: (c, s) => P(), routes: [\n" + kids + "  ]),\n  GoRoute(path: '/after', builder: (c, s) => A()),\n]);\n";
    expect(src.length).toBeGreaterThan(10_000);
    const routes = run('lib/router.dart', src);
    expect(routes).toHaveLength(302);
    expect(routes.slice(1, 301).every((r, i) => r.path === `/p/c${i}` && r.handler === `Child${i}`)).toBe(true);
    expect(routes[301]).toMatchObject({ path: '/after', handler: 'A' });
  });

  it('survives malformed input and stays linear on ~1 MB', () => {
    expect(() => run('src/Nav.tsx', '<Stack.Screen name="A" component={')).not.toThrow();
    expect(() => run('lib/r.dart', "GoRoute(path: '/a', routes: [GoRoute(")).not.toThrow();
    for (const [rel, t] of [['src/Nav.tsx', '<Stack.Screen name="A" '.repeat(45000)], ['lib/r.dart', "GoRoute(path: 'a', routes: [".repeat(35000)]] as const) {
      const start = performance.now();
      run(rel, t);
      expect(performance.now() - start, rel).toBeLessThan(1000);
    }
  });
});
