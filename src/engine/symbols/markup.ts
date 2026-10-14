import type { CodeSymbol } from '../../shared/types.js';
import { hashText, MAX_SYMBOLS } from './helpers.js';

const HEADING = /^ {0,3}(#{1,4})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Headings `#`..`####` outside fenced code, nested by level (qname joined with " > "). */
export function markdownOutline(src: string): CodeSymbol[] {
  const lines = src.split(/\r?\n/);
  const flat: { sym: CodeSymbol; level: number }[] = [];
  const roots: CodeSymbol[] = [];
  const stack: { sym: CodeSymbol; level: number }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = HEADING.exec(line);
    if (!m || flat.length >= MAX_SYMBOLS) continue;
    const level = m[1].length;
    const name = m[2].trim();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].sym : undefined;
    const sym: CodeSymbol = {
      name,
      qname: parent ? `${parent.qname} > ${name}` : name,
      kind: 'heading',
      signature: `${m[1]} ${name}`,
      line: i + 1,
      endLine: lines.length,
      exported: false,
      hash: '',
      children: [],
    };
    (parent ? parent.children : roots).push(sym);
    const entry = { sym, level };
    stack.push(entry);
    flat.push(entry);
  }
  // A section ends the line before the next heading of the same or a higher level.
  for (let k = 0; k < flat.length; k++) {
    const { sym, level } = flat[k];
    let end = lines.length;
    for (let j = k + 1; j < flat.length; j++) {
      if (flat[j].level <= level) { end = flat[j].sym.line - 1; break; }
    }
    sym.endLine = Math.max(end, sym.line);
    sym.hash = hashText(lines.slice(sym.line - 1, sym.endLine).join('\n'));
  }
  return roots;
}

/** First `<script>` block of a Vue/Svelte file; lineOffset is the number of lines before the code starts. */
export function scriptBlock(src: string): { code: string; lineOffset: number } | null {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(src);
  if (!m) return null;
  const codeStart = m.index + m[0].indexOf('>') + 1;
  let lineOffset = 0;
  for (let i = 0; i < codeStart; i++) if (src.charCodeAt(i) === 10) lineOffset++;
  return { code: m[1], lineOffset };
}

export function shiftLines(symbols: CodeSymbol[], by: number): CodeSymbol[] {
  return symbols.map(s => ({ ...s, line: s.line + by, endLine: s.endLine + by, children: shiftLines(s.children, by) }));
}
