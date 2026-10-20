import type { FileModel } from '@shared/types.js';

export type Layer = 'ui' | 'api' | 'core' | 'logic' | 'val' | 'data' | 'security' | 'ai' | 'test' | 'docs' | 'config';

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
  security: { name: 'Security', color: 'var(--red)', tint: 'var(--red-t)' },
  ai: { name: 'AI', color: 'var(--indigo)', tint: 'var(--indigo-t)' },
  test: { name: 'Tests', color: 'var(--green)', tint: 'var(--green-t)' },
  docs: { name: 'Docs', color: 'var(--ink2)', tint: 'var(--hair)' },
  config: { name: 'Config', color: 'var(--ink2)', tint: 'var(--hair)' },
};

/** Order of folder groups and of the legend. */
export const LAYER_ORDER: Layer[] = ['ui', 'api', 'core', 'logic', 'val', 'data', 'security', 'ai', 'test', 'docs', 'config'];

/**
 * ServiceNow mirror folders (plugins/servicenow/mirror.ts): `<scope>/<kind>/...`, where a scope is
 * `x_vendor_app`, `sn_app` or `global`. Experience (portals, pages, widgets, workspaces) is the UI layer.
 */
const SN_KIND_LAYER: Record<string, Layer> = {
  portal: 'ui', page: 'ui', widget: 'ui', workspace: 'ui',
  business_rule: 'logic', client_script: 'logic', script_include: 'logic', ui_action: 'logic', ui_policy: 'logic', flow: 'logic',
  rest: 'api', schema: 'data', acl: 'security', ai_agent: 'ai', other: 'config',
};
const SN_SCOPE = /^(x_[a-z0-9_]+|sn_[a-z0-9_]+|global)$/i;

/**
 * The layer of a ServiceNow mirror path, or null for any other path. Runs for every file the UI indexes, so it
 * checks the cheap parts (depth, kind) before the scope pattern.
 */
export function serviceNowLayer(path: string, segs: string[] = path.split('/')): Layer | null {
  if (segs.length < 3) return null;
  const layer = Object.hasOwn(SN_KIND_LAYER, segs[1]) ? SN_KIND_LAYER[segs[1]] : undefined;
  return layer && SN_SCOPE.test(segs[0]) ? layer : null;
}

const SEGMENT_LAYER: [RegExp, Layer][] = [
  [/^(components|pages|app|views|screens|hooks|web|ui|client)$/, 'ui'],
  [/^(routes|controllers|api|handlers|endpoints)$/, 'api'],
  [/^(services|domain|usecases)$/, 'logic'],
  [/^(validation|schemas|validators)$/, 'val'],
  [/^(db|models|prisma|migrations|entities|repositories)$/, 'data'],
];

const TEST_SEG = /^(test|tests|__tests__|spec)$/;
const DOCS_SEG = /^(docs|documentation)$/;
/** Coding agents' folders (skills, hooks, rules): tooling, not the app. */
const AGENT_SEG = /^\.(agents|claude|cursor|codex|gemini|windsurf)$/;
const CONFIG_LANGS = new Set(['json', 'yaml', 'toml', 'secret']);
const CONFIG_NAME = /(^|\.)(config|rc)\.[a-z]+$|^\.[a-z]+rc$|^(dockerfile|makefile|\.gitignore|\.dockerignore|\.editorconfig|\.npmrc|\.nvmrc)$/;

/**
 * Heuristic layer for a file from its path. Tests, docs (by extension or a docs folder), data files by
 * extension and config (or an agent folder) come first; then the deepest folder (or file stem) that names a layer wins; else core.
 */
export function layerOf(path: string, file: FileModel): Layer {
  const lower = path.toLowerCase();
  const segs = lower.split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  const stem = base.replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');
  const sn = serviceNowLayer(path, segs);
  if (sn) return sn;

  if (dirs.some(s => TEST_SEG.test(s)) || /\.(test|spec)\./.test(base)) return 'test';
  if (file.lang === 'markdown' || /\.mdx?$/.test(base) || dirs.some(s => DOCS_SEG.test(s))) return 'docs';
  if (file.lang === 'sql' || file.lang === 'prisma' || /\.(sql|prisma)$/.test(base)) return 'data';
  if (CONFIG_LANGS.has(file.lang) || /\.(json|ya?ml|toml|ini)$/.test(base) || CONFIG_NAME.test(base) || dirs.some(s => AGENT_SEG.test(s))) return 'config';

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
