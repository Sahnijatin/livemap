import { describe, it, expect } from 'vitest';
import { markdownOutline, scriptBlock } from '../../src/engine/symbols/markup.js';
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

describe('scriptBlock', () => {
  it('returns code and line offset', () => {
    expect(scriptBlock('<template>\n</template>\n<script>\nlet a\n</script>')).toEqual({ code: '\nlet a\n', lineOffset: 2 });
    expect(scriptBlock('<div/>')).toBeNull();
  });
});

describe('fileSymbols', () => {
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
