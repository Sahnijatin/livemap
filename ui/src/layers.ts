import type { FileModel } from '@shared/types.js';

export type Layer = 'ui' | 'api' | 'core' | 'logic' | 'val' | 'data' | 'test' | 'docs' | 'config';

export interface LayerMeta {
  name: string;
  /** CSS color for icon and text. */
  color: string;
  /** CSS tint for icon backgrounds and tags. */
  tint: string;
}

/** Colors follow the prototype: UI purple, API blue, Server indigo, Logic teal, Validation pink, Data orange. */
export const LAYERS: Record<Layer, LayerMeta> = {
  ui: { name: 'Interface', color: 'var(--purple)', tint: 'var(--purple-t)' },
  api: { name: 'API', color: 'var(--blue)', tint: 'var(--blue-t)' },
  core: { name: 'Server', color: 'var(--indigo)', tint: 'var(--indigo-t)' },
  logic: { name: 'Logic', color: 'var(--teal)', tint: 'var(--teal-t)' },
  val: { name: 'Validation', color: 'var(--pink)', tint: 'var(--red-t)' },
  data: { name: 'Data', color: 'var(--orange)', tint: 'var(--orange-t)' },
  test: { name: 'Tests', color: 'var(--green)', tint: 'var(--green-t)' },
  docs: { name: 'Docs', color: 'var(--ink2)', tint: 'var(--hair)' },
  config: { name: 'Config', color: 'var(--ink2)', tint: 'var(--hair)' },
};

/** Order of folder groups and of the legend. */
export const LAYER_ORDER: Layer[] = ['ui', 'api', 'core', 'logic', 'val', 'data', 'test', 'docs', 'config'];

const SEGMENT_LAYER: [RegExp, Layer][] = [
  [/^(components|pages|app|views|screens|hooks|web|ui|client)$/, 'ui'],
  [/^(routes|controllers|api|handlers|endpoints)$/, 'api'],
  [/^(services|domain|usecases)$/, 'logic'],
  [/^(validation|schemas|validators)$/, 'val'],
  [/^(db|models|prisma|migrations|entities|repositories)$/, 'data'],
];

const TEST_SEG = /^(test|tests|__tests__|spec)$/;
const CONFIG_LANGS = new Set(['json', 'yaml', 'toml', 'secret']);
const CONFIG_NAME = /(^|\.)(config|rc)\.[a-z]+$|^\.[a-z]+rc$|^(dockerfile|makefile|\.gitignore|\.dockerignore|\.editorconfig|\.npmrc|\.nvmrc)$/;

/**
 * Heuristic layer for a file from its path. Tests, docs, data files by extension and config
 * come first; then the deepest folder (or file stem) that names a layer wins; else core.
 */
export function layerOf(path: string, file: FileModel): Layer {
  const lower = path.toLowerCase();
  const segs = lower.split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  const stem = base.replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');

  if (dirs.some(s => TEST_SEG.test(s)) || /\.(test|spec)\./.test(base)) return 'test';
  if (file.lang === 'markdown' || /\.mdx?$/.test(base)) return 'docs';
  if (file.lang === 'sql' || file.lang === 'prisma' || /\.(sql|prisma)$/.test(base)) return 'data';
  if (CONFIG_LANGS.has(file.lang) || /\.(json|ya?ml|toml|ini)$/.test(base) || CONFIG_NAME.test(base)) return 'config';

  for (let i = dirs.length - 1; i >= 0; i--) {
    if (dirs[i] === 'logic' && dirs[i - 1] === 'lib') return 'logic';
    for (const [re, layer] of SEGMENT_LAYER) if (re.test(dirs[i])) {
      // The file's own stem can be more specific than its folder (lib/validation.ts).
      return stemLayer(stem) ?? layer;
    }
  }
  return stemLayer(stem) ?? 'core';
}

function stemLayer(stem: string): Layer | null {
  for (const [re, layer] of SEGMENT_LAYER) if (layer !== 'ui' && re.test(stem)) return layer;
  return null;
}
