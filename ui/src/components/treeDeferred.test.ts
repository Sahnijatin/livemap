import { describe, it, expect } from 'vitest';
import { file } from '../fixtures';
import { buildTree, dirKey, visibleItems } from '../treeModel';
import { namesFor } from './treeDeferred';

describe('typeahead names', () => {
  it('are built once per row list: each folder of a compact row, and file names', () => {
    const files = Object.fromEntries(['src/app/page.tsx', 'README.md'].map(p => [p, file(p)]));
    const { items } = visibleItems(buildTree(files, '').root, () => true, () => false, new Map());
    const names = namesFor(items);
    expect(namesFor(items)).toBe(names);
    expect(names.get(dirKey('src/app'))).toEqual(['src', 'app']);
    expect(names.get('README.md')).toEqual(['readme.md']);
    expect(namesFor([...items])).not.toBe(names);
  });
});
