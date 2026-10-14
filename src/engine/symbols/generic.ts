import type { Node } from 'web-tree-sitter';
import type { CodeSymbol, Lang, SymbolKind } from '../../shared/types.js';
import { type Budget, hashText, makeSymbol, namedKids, signatureOf, tidySignature } from './helpers.js';

/** Node type to symbol kind, per language. `function` inside a CONTAINER symbol is promoted to `method`. */
const DEFS: Partial<Record<Lang, Record<string, SymbolKind>>> = {
  python: { function_definition: 'function', class_definition: 'class' },
  go: { function_declaration: 'function', method_declaration: 'method', type_spec: 'type' },
  rust: {
    function_item: 'function', function_signature_item: 'function', struct_item: 'struct', enum_item: 'enum',
    trait_item: 'trait', impl_item: 'impl', mod_item: 'module', type_item: 'type',
  },
  java: {
    class_declaration: 'class', record_declaration: 'class', interface_declaration: 'interface',
    annotation_type_declaration: 'interface', enum_declaration: 'enum',
    method_declaration: 'method', constructor_declaration: 'method',
  },
  kotlin: { class_declaration: 'class', object_declaration: 'class', function_declaration: 'function' },
  csharp: {
    namespace_declaration: 'namespace', file_scoped_namespace_declaration: 'namespace',
    class_declaration: 'class', record_declaration: 'class', struct_declaration: 'struct',
    interface_declaration: 'interface', enum_declaration: 'enum',
    method_declaration: 'method', constructor_declaration: 'method',
  },
  php: {
    namespace_definition: 'namespace', class_declaration: 'class', interface_declaration: 'interface',
    trait_declaration: 'trait', enum_declaration: 'enum', function_definition: 'function', method_declaration: 'method',
  },
  ruby: { class: 'class', module: 'module', method: 'method', singleton_method: 'method' },
  swift: {
    class_declaration: 'class', protocol_declaration: 'interface',
    function_declaration: 'function', protocol_function_declaration: 'function',
  },
  c: { function_definition: 'function', struct_specifier: 'struct', union_specifier: 'struct', enum_specifier: 'enum' },
  cpp: {
    function_definition: 'function', struct_specifier: 'struct', union_specifier: 'struct', enum_specifier: 'enum',
    class_specifier: 'class', namespace_definition: 'namespace',
  },
  dart: {
    class_definition: 'class', enum_declaration: 'enum', mixin_declaration: 'trait',
    function_signature: 'function', constructor_signature: 'method',
  },
};

/** Symbol kinds whose direct functions are methods. */
const CONTAINER = new Set<SymbolKind>(['class', 'interface', 'struct', 'trait', 'impl', 'enum']);
/** Symbol kinds whose bodies are searched for further symbols. */
const HOLDS_CHILDREN = new Set<SymbolKind>([...CONTAINER, 'namespace', 'module']);
/** Pure structural wrappers: walked through without producing a symbol. */
const WRAPPERS = new Set([
  'decorated_definition', 'block', 'declaration_list', 'field_declaration_list', 'body_statement',
  'template_declaration', 'type_declaration', 'enum_body_declarations', 'method_signature', 'linkage_specification', 'declaration',
]);
const FUNCTION_BODIES = new Set(['function_body', 'constructor_body', 'compound_statement']);
const NAME_TYPES = new Set(['identifier', 'type_identifier', 'simple_identifier', 'constant', 'name', 'field_identifier']);
const DECLARATOR_NAME_TYPES = new Set([...NAME_TYPES, 'qualified_identifier', 'destructor_name', 'operator_name']);
const BODY_TYPES = new Set([
  'class_body', 'interface_body', 'enum_body', 'protocol_body', 'enum_class_body', 'field_declaration_list',
  'declaration_list', 'function_body', 'block', 'compound_statement', 'body_statement',
]);
/** C-family specifiers are only definitions when they have a body (otherwise they are type references). */
const NEEDS_BODY = new Set(['struct_specifier', 'union_specifier', 'enum_specifier', 'class_specifier']);

function isWrapper(type: string): boolean {
  return WRAPPERS.has(type) || (/_body$/.test(type) && !FUNCTION_BODIES.has(type));
}

function declaratorName(node: Node): string | null {
  let cur: Node | null = node.childForFieldName('declarator');
  while (cur && !DECLARATOR_NAME_TYPES.has(cur.type)) cur = cur.childForFieldName('declarator');
  return cur ? cur.text : null;
}

function nameOf(node: Node): string | null {
  const field = node.childForFieldName('name');
  if (field) return field.text;
  for (const c of namedKids(node)) if (NAME_TYPES.has(c.type)) return c.text;
  return declaratorName(node);
}

function bodyOf(node: Node): Node | null {
  const field = node.childForFieldName('body') ?? node.childForFieldName('type')?.childForFieldName('body');
  if (field) return field;
  const goType = node.childForFieldName('type');
  const inner = goType ? namedKids(goType).find(c => BODY_TYPES.has(c.type)) : undefined;
  return inner ?? namedKids(node).find(c => BODY_TYPES.has(c.type)) ?? null;
}

/** Go receiver type name, without pointer or generic parts. */
function goReceiver(node: Node): string | null {
  const recv = node.childForFieldName('receiver');
  const text = recv ? namedKids(recv)[0]?.childForFieldName('type')?.text : undefined;
  return text ? text.replace(/^\*/, '').replace(/\[.*$/, '') : null;
}

function rustImplName(node: Node): string | null {
  const type = node.childForFieldName('type')?.text;
  if (!type) return null;
  const trait = node.childForFieldName('trait')?.text;
  return trait ? `${trait} for ${type}` : type;
}

/** Applies the few per-grammar kind refinements that the node type alone cannot express. */
function refineKind(lang: Lang, node: Node, kind: SymbolKind): SymbolKind {
  if (lang === 'go' && node.type === 'type_spec') {
    const t = node.childForFieldName('type')?.type;
    return t === 'struct_type' ? 'struct' : t === 'interface_type' ? 'interface' : 'type';
  }
  if (lang === 'swift' && node.type === 'class_declaration') {
    const k = node.childForFieldName('declaration_kind')?.text;
    return k === 'struct' ? 'struct' : k === 'enum' ? 'enum' : k === 'extension' ? 'impl' : 'class';
  }
  if (lang === 'kotlin' && node.type === 'class_declaration') {
    const kws = node.children.filter((c): c is Node => c !== null && !c.isNamed).map(c => c.type);
    if (kws.includes('interface')) return 'interface';
    if (namedKids(node).some(c => c.type === 'modifiers' && /\benum\b/.test(c.text))) return 'enum';
  }
  return kind;
}

function isExported(lang: Lang, name: string, node: Node, signature: string): boolean {
  switch (lang) {
    case 'python': case 'dart': return !name.startsWith('_');
    case 'go': return /^[A-Z]/.test(name);
    case 'rust': return namedKids(node).some(c => c.type === 'visibility_modifier');
    case 'java': case 'csharp': return /\bpublic\b/.test(signature);
    case 'kotlin': case 'swift': case 'php': return !/\b(private|fileprivate)\b/.test(signature);
    case 'c': case 'cpp': return !/\bstatic\b/.test(signature);
    default: return true;
  }
}

function dartBody(node: Node): Node | null {
  const outer = node.parent?.type === 'method_signature' ? node.parent : node;
  const next = outer.nextNamedSibling;
  return next && next.type === 'function_body' ? next : null;
}

function visit(lang: Lang, node: Node, parent: CodeSymbol | undefined, budget: Budget, out: CodeSymbol[]): boolean {
  const defs = DEFS[lang]!;
  for (const c of namedKids(node)) {
    let inner = c;
    let span = c;
    if (c.type === 'decorated_definition') {
      const def = c.childForFieldName('definition');
      if (!def) continue;
      inner = def;
    }
    const baseKind = defs[inner.type];
    if (baseKind === undefined) {
      // PHP braced `namespace X { ... }` uses a compound_statement as its member block.
      const wrap = isWrapper(c.type) || (c.type === 'compound_statement' && node.type === 'namespace_definition');
      if (wrap && !visit(lang, c, parent, budget, out)) return false;
      continue;
    }
    if (NEEDS_BODY.has(inner.type) && !inner.childForFieldName('body')) continue;
    let kind = refineKind(lang, inner, baseKind);
    let name: string | null;
    let qnameOverride: string | undefined;
    if (inner.type === 'impl_item') name = rustImplName(inner);
    else name = nameOf(inner);
    if (!name) continue;
    if (lang === 'go' && inner.type === 'method_declaration') {
      const recv = goReceiver(inner);
      if (recv) qnameOverride = `${recv}.${name}`;
    }
    if (kind === 'function' && parent && CONTAINER.has(parent.kind)) kind = 'method';
    if (span === inner && c.parent?.type === 'method_signature') span = c.parent;
    const signature = signatureOf(inner, bodyOf(inner));
    const sym = makeSymbol(budget, span, parent, { name, kind, signature, exported: isExported(lang, name, inner, signature) });
    if (!sym) return false;
    if (qnameOverride) sym.qname = qnameOverride;
    if (lang === 'dart') {
      const body = dartBody(inner);
      if (body) {
        sym.endLine = body.endPosition.row + 1;
        sym.hash = hashText(span.text + body.text);
      }
    }
    sym.signature = tidySignature(sym.signature);
    out.push(sym);
    if (HOLDS_CHILDREN.has(kind)) {
      // C# file-scoped namespaces have no body: their members are siblings inside the same node.
      if (!visit(lang, inner, sym, budget, sym.children)) return false;
    }
  }
  return true;
}

export function extractGeneric(root: Node, lang: Lang, budget: Budget): CodeSymbol[] {
  if (!DEFS[lang]) return [];
  const out: CodeSymbol[] = [];
  visit(lang, root, undefined, budget, out);
  return out;
}
