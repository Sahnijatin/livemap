import type { Node } from 'web-tree-sitter';
import type { CodeSymbol, Lang, SymbolKind } from '../../shared/types.js';
import { type Budget, allKids, makeSymbol, namedKids, signatureOf, tidySignature } from './helpers.js';

const JSX_TYPES = ['jsx_element', 'jsx_self_closing_element', 'jsx_fragment'];
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

const DECL_KINDS: Record<string, SymbolKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  internal_module: 'namespace',
};

const isCapitalized = (n: string) => /^[A-Z]/.test(n);
const isHook = (n: string) => /^use[A-Z]/.test(n);

function hasJsx(node: Node): boolean {
  try {
    return node.descendantsOfType(JSX_TYPES).length > 0;
  } catch {
    return false;
  }
}

/** Promotes a function-like symbol to component or hook based on name and JSX content. */
function functionKind(name: string, node: Node): SymbolKind {
  if (isCapitalized(name) && hasJsx(node)) return 'component';
  if (isHook(name)) return 'hook';
  return 'function';
}

function arrowSignature(name: string, fn: Node): string {
  const isAsync = allKids(fn).some(c => c.type === 'async');
  const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
  const ret = fn.childForFieldName('return_type');
  const p = params ? (params.type === 'identifier' ? `(${params.text})` : params.text) : '()';
  return tidySignature(`${isAsync ? 'async ' : ''}${name}${p}${ret ? ret.text : ''}`);
}

function classMembers(cls: Node, sym: CodeSymbol, budget: Budget): void {
  const body = cls.childForFieldName('body');
  if (!body) return;
  for (const m of namedKids(body)) {
    // The JS grammar names class fields (`field_definition`) by `property`, TS (`public_field_definition`) by `name`.
    const name = (m.childForFieldName('name') ?? m.childForFieldName('property'))?.text;
    if (!name) continue;
    let signature: string | null = null;
    if (m.type === 'method_definition' || m.type === 'abstract_method_signature') {
      signature = signatureOf(m);
    } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
      const value = m.childForFieldName('value');
      if (value && FUNCTION_VALUES.has(value.type)) signature = arrowSignature(name, value);
    }
    if (signature === null) continue;
    const child = makeSymbol(budget, m, sym, { name, kind: 'method', signature, exported: false });
    if (child) sym.children.push(child);
  }
}

function declaration(node: Node, exported: boolean, outer: Node, budget: Budget, out: CodeSymbol[]): void {
  const kind = DECL_KINDS[node.type];
  if (kind) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const finalKind = kind === 'function' ? functionKind(name, node) : kind;
    const sym = makeSymbol(budget, outer, undefined, { name, kind: finalKind, signature: signatureOf(outer, node.childForFieldName('body')), exported });
    if (!sym) return;
    if (kind === 'class') classMembers(node, sym, budget);
    out.push(sym);
    return;
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarators = namedKids(node).filter(c => c.type === 'variable_declarator');
    for (const d of declarators) {
      const nameNode = d.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      const name = nameNode.text;
      const value = d.childForFieldName('value');
      const span = declarators.length === 1 ? outer : d;
      let kindOut: SymbolKind = 'variable';
      let signature: string | null = null;
      if (value && FUNCTION_VALUES.has(value.type)) {
        kindOut = functionKind(name, value);
        signature = arrowSignature(name, value);
      } else if (value && value.type === 'call_expression' && isCapitalized(name) && hasJsx(value)) {
        kindOut = 'component';
      }
      const sym = makeSymbol(budget, span, undefined, { name, kind: kindOut, signature: signature ?? signatureOf(span, null), exported });
      if (sym) out.push(sym);
    }
  }
}

/** Local names exported by `export { a, b as c }` (no `from`) and `export default <identifier>`. */
function exportedNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const stmt of namedKids(root)) {
    if (stmt.type !== 'export_statement' || stmt.childForFieldName('source')) continue;
    const value = stmt.childForFieldName('value');
    if (value?.type === 'identifier') names.add(value.text);
    for (const clause of namedKids(stmt).filter(c => c.type === 'export_clause')) {
      for (const spec of namedKids(clause)) {
        const n = spec.type === 'export_specifier' ? spec.childForFieldName('name') : null;
        if (n) names.add(n.text);
      }
    }
  }
  return names;
}

export function extractJs(root: Node, _lang: Lang, budget: Budget): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (const stmt of namedKids(root)) {
    if (stmt.type === 'export_statement') {
      const decl = stmt.childForFieldName('declaration');
      if (decl) declaration(decl, true, stmt, budget, out);
    } else if (stmt.type === 'expression_statement' && stmt.firstNamedChild?.type === 'internal_module') {
      declaration(stmt.firstNamedChild, false, stmt, budget, out);
    } else {
      declaration(stmt, false, stmt, budget, out);
    }
  }
  const named = exportedNames(root);
  if (named.size) for (const sym of out) if (named.has(sym.name)) sym.exported = true;
  return out;
}
