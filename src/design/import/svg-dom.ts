import {importSvg, SVG_IMPORT_LIMITS, type SvgImportOptions, type SvgImportResult, type SvgNode} from '../../../shared/design/svg-import';

// Pasted or dropped SVG text → the plain tree shared/design/svg-import.ts maps into nodes.
// The text is parsed with DOMParser as XML into a detached document: nothing is inserted into
// the page, no script runs, no resource loads (docs/design-tool.md §Rules). This adapter only
// copies what the importer reads, within limits: 2 MB of text, 20 000 elements, 64 levels. It
// drops scripts, foreignObject, event attributes and every reference that leaves the document
// (the importer would skip them too; dropping them here keeps them out of memory altogether).

export type SvgDomError = 'too_large' | 'entities' | 'parse' | 'not_svg';

export const SVG_DOM_ERRORS: Record<SvgDomError, string> = {
  too_large: 'SVG is larger than 2 MB: such a file cannot be inserted',
  entities: 'SVG with entity declarations (ENTITY) is not supported',
  parse: 'Could not read the SVG: the file is damaged',
  not_svg: 'This is not an SVG',
};

export const SVG_DOM_WARNINGS = {
  elements: 'The SVG has too many elements: only part was imported',
  depth: 'Nesting is too deep: deep elements were skipped',
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_PARENTS = new Set(['text', 'tspan', 'textPath', 'a', 'style', 'title']);
const DROPPED = new Set(['script', 'foreignObject', 'iframe', 'audio', 'video', 'canvas']);
const ELEMENT = 1, TEXT = 3, CDATA = 4;

/** The parts of DOM nodes this adapter reads. Real DOM nodes satisfy it; tests pass plain objects. */
export type DomNodeLike = {
  nodeType: number;
  nodeValue?: string | null;
  localName?: string;
  namespaceURI?: string | null;
  attributes?: ArrayLike<{name: string; value: string}>;
  childNodes: ArrayLike<DomNodeLike>;
};

/** Keeps same-document references and embedded pictures; anything that would reach out is dropped. */
function safeAttribute(name: string, value: string): boolean {
  if (/^on/i.test(name)) return false;
  if (name === 'href' || name === 'xlink:href') {
    const v = value.trim();
    return v.startsWith('#') || /^data:image\//i.test(v);
  }
  return true;
}

/** The plain tree of an <svg> element (iterative, so depth never touches the call stack). */
export function svgTreeFromElement(root: DomNodeLike): {tree: SvgNode; warnings: string[]} {
  const warnings = new Set<string>();
  let elements = 0;
  const copy = (el: DomNodeLike): SvgNode => {
    elements++;
    const attrs: Record<string, string> = {};
    const list = el.attributes ?? [];
    for (let k = 0; k < list.length; k++) {
      const {name, value} = list[k];
      if (safeAttribute(name, value)) attrs[name] = value;
    }
    return {tag: el.localName ?? '', attrs, children: []};
  };
  const tree = copy(root);
  const stack: {dom: DomNodeLike; node: SvgNode; depth: number}[] = [{dom: root, node: tree, depth: 0}];
  while (stack.length) {
    const {dom, node, depth} = stack.pop()!;
    const children = dom.childNodes;
    const pending: {dom: DomNodeLike; node: SvgNode; depth: number}[] = [];
    for (let k = 0; k < children.length; k++) {
      const child = children[k];
      if (child.nodeType === TEXT || child.nodeType === CDATA) {
        if (TEXT_PARENTS.has(node.tag) && child.nodeValue) node.children.push({tag: '#text', attrs: {}, children: [], text: child.nodeValue});
        continue;
      }
      if (child.nodeType !== ELEMENT) continue;
      const namespace = child.namespaceURI ?? null;
      if ((namespace !== SVG_NS && namespace !== null) || DROPPED.has(child.localName ?? '')) continue;
      if (depth + 1 > SVG_IMPORT_LIMITS.depth) { warnings.add(SVG_DOM_WARNINGS.depth); continue; }
      if (elements >= SVG_IMPORT_LIMITS.elements) { warnings.add(SVG_DOM_WARNINGS.elements); break; }
      const copied = copy(child);
      node.children.push(copied);
      pending.push({dom: child, node: copied, depth: depth + 1});
    }
    // Depth-first in document order: push in reverse so the first child is handled first.
    for (let k = pending.length - 1; k >= 0; k--) stack.push(pending[k]);
  }
  return {tree, warnings: [...warnings]};
}

/** UTF-8 size without building the bytes for short strings. */
function byteLength(source: string): number {
  if (source.length * 3 <= SVG_IMPORT_LIMITS.inputBytes) return source.length * 3;
  return new TextEncoder().encode(source).length;
}

/** Parses SVG text into the plain tree, or says why it cannot. `parse` is DOMParser by default. */
export function svgTreeFromString(source: string, parse: (text: string) => {documentElement: DomNodeLike | null; getElementsByTagName(name: string): ArrayLike<unknown>} = text => new DOMParser().parseFromString(text, 'image/svg+xml')): {tree: SvgNode; warnings: string[]} | {error: SvgDomError} {
  if (byteLength(source) > SVG_IMPORT_LIMITS.inputBytes) return {error: 'too_large'};
  // Entity declarations are how "billion laughs" files explode inside an XML parser.
  if (/<!ENTITY/i.test(source)) return {error: 'entities'};
  let doc: ReturnType<typeof parse>;
  try {
    doc = parse(source);
  } catch {
    return {error: 'parse'};
  }
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length || root.localName === 'parsererror') return {error: 'parse'};
  if (root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== SVG_NS)) return {error: 'not_svg'};
  return svgTreeFromElement(root);
}

/** Text → nodes in one step, with every warning of both stages. */
export function importSvgString(source: string, options: SvgImportOptions = {}): SvgImportResult | {error: SvgDomError; message: string} {
  const parsed = svgTreeFromString(source);
  if ('error' in parsed) return {error: parsed.error, message: SVG_DOM_ERRORS[parsed.error]};
  const result = importSvg(parsed.tree, options);
  return {...result, warnings: [...parsed.warnings, ...result.warnings]};
}
