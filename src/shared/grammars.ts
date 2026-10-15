import type { Lang } from './types.js';

/** The languages the code view highlights (ui/scripts/export-grammars.mjs builds their grammars). */
export const HIGHLIGHTED: Lang[] = [
  'typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift',
  'c', 'cpp', 'dart', 'vue', 'svelte', 'sql', 'prisma', 'markdown', 'json', 'yaml', 'toml', 'css', 'html', 'shell',
];

/**
 * The Shiki grammar for a file: its language's name, shellscript for shell. JSX files are classified as
 * javascript by the engine; the jsx grammar handles both. Languages outside HIGHLIGHTED have no grammar.
 */
export function grammarId(lang: Lang, path: string): string {
  if (/\.jsx$/i.test(path)) return 'jsx';
  return lang === 'shell' ? 'shellscript' : lang;
}
