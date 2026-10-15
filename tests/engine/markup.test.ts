import { describe, it, expect } from 'vitest';
import { markdownOutline, scriptBlocks } from '../../src/engine/symbols/markup.js';
import { fileSymbols } from '../../src/engine/symbols/index.js';

describe('markdownOutline', () => {
  it('nests headings by level and ignores fenced code', () => {
    const src = '# A\n\ntext\n\n## B\n\n```\n# not\n```\n\n## C\n';
    const out = markdownOutline(src);
    expect(out.map(s => s.name)).toEqual(['A']);
    expect(out[0].kind).toBe('heading');
    expect(out[0].children.map(s => s.name)).toEqual(['B', 'C']);
    expect(out[0].children[1].qname).toBe('A > C');
    expect(out[0].children[0].line).toBe(5);
    expect(out[0].children[0].endLine).toBe(10);
    expect(out[0].hash).toMatch(/^[0-9a-f]{12}$/);
  });
  it('handles skipped levels and ignores ##### headings', () => {
    const out = markdownOutline('## X\n#### Y\n##### Z\n# W\n');
    expect(out.map(s => s.name)).toEqual(['X', 'W']);
    expect(out[0].children.map(s => s.qname)).toEqual(['X > Y']);
  });
});

describe('scriptBlocks', () => {
  it('returns code and line offset', () => {
    expect(scriptBlocks('<template>\n</template>\n<script>\nlet a\n</script>')).toEqual([{ code: '\nlet a\n', lineOffset: 2 }]);
    expect(scriptBlocks('<div/>')).toEqual([]);
  });
  it('returns every block, each with its own offset (#26)', () => {
    const src = '<script lang="ts">\nexport default {}\n</script>\n<template>\n<p/>\n</template>\n<script setup lang="ts">\nlet b\n</script>\n';
    expect(scriptBlocks(src)).toEqual([
      { code: '\nexport default {}\n', lineOffset: 0 },
      { code: '\nlet b\n', lineOffset: 6 },
    ]);
  });
});

describe('fileSymbols', () => {
  it('shares the per-file symbol cap across every script block', async () => {
    const fns = (p: string) => Array.from({ length: 1000 }, (_, i) => `export function ${p}${i}() {}`).join('\n');
    const src = `<script lang="ts">\n${fns('a')}\n</script>\n<script setup lang="ts">\n${fns('b')}\n</script>\n`;
    const r = await fileSymbols('vue', src, 'Big.vue');
    expect(r.symbols[0].children.length).toBeLessThanOrEqual(1500);
    expect(r.symbols[0].children.some(c => c.name === 'b0')).toBe(true);
  });

  it('vue file yields a component with shifted children', async () => {
    const src = '<template>\n<div>\n</div>\n<p/>\n</template>\n<script setup lang="ts">function go() {}</script>\n';
    const r = await fileSymbols('vue', src, 'src/Widget.vue');
    expect(r.ok).toBe(true);
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0].kind).toBe('component');
    expect(r.symbols[0].name).toBe('Widget');
    const go = r.symbols[0].children[0];
    expect(go.name).toBe('go');
    expect(go.line).toBe(6);
  });
  it('vue and svelte keep symbols from every script block at their own lines (#26)', async () => {
    const vue = '<script lang="ts">\nexport interface Props { a: string }\n</script>\n<template>\n<p/>\n</template>\n<script setup lang="ts">\nfunction go() {}\n</script>\n';
    const v = await fileSymbols('vue', vue, 'W.vue');
    expect(v.symbols[0].children.map(s => [s.name, s.line])).toEqual([['Props', 2], ['go', 8]]);
    const svelte = '<script context="module">\nexport function load() {}\n</script>\n\n<script>\nlet n = 0;\nfunction inc() { n++; }\n</script>\n<button on:click={inc}>{n}</button>\n';
    const s = await fileSymbols('svelte', svelte, 'C.svelte');
    expect(s.symbols[0].children.map(x => [x.name, x.line])).toEqual([['load', 2], ['n', 6], ['inc', 7]]);
  });
  it('svelte without script has no children; markdown routes to outline', async () => {
    const s = await fileSymbols('svelte', '<h1>x</h1>', 'Card.svelte');
    expect(s.ok).toBe(true);
    expect(s.symbols[0].name).toBe('Card');
    expect(s.symbols[0].children).toEqual([]);
    const m = await fileSymbols('markdown', '# Hi\n');
    expect(m.ok).toBe(true);
    expect(m.symbols[0].name).toBe('Hi');
  });
});
