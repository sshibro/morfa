import type {DesignDocument, ImageRef, NodeId, SceneNode} from '../types';
import {createNode} from '../defaults';
import {localMatrix, transformRect, type Rect} from '../geometry';
import {exportSvg} from '../svg-export';
import type {TextMeasurer} from '../text-layout';
import {needsSvg, turned, VECTOR_TYPES} from './css';
import {isVisiblePaint, num} from './values';

// Vectors in code are inline SVG (docs/design-tool.md §Design to code). The picture comes from the
// SVG exporter (shared/design/svg-export.ts), so code draws exactly what "Export → SVG" draws; this
// module places it and turns the markup into JSX.
//
// Placement: the exporter crops to what a layer paints, which may reach past its box (strokes,
// shadows). To know where the box sits in that picture, the layer is exported beside an empty
// rectangle a margin larger than anything it paints, so the picture's origin is that rectangle's
// corner; the JSX then views exactly the layer's box and lets the rest overflow.

export type SvgNode = {tag: string; attrs: [string, string][]; children: (SvgNode | string)[]};

export type InlineSvg = {
  root: SvgNode;
  /** The box the <svg> element takes, in the parent's space (the layer's box, or the bounds of a turned one). */
  box: Rect;
  viewBox: string;
  /** The one colour the picture uses, replaced by currentColor (set it with CSS `color`). */
  monochrome: string | null;
};

const PAINTED = new Set(['RECTANGLE', 'ELLIPSE', 'LINE', 'GROUP', 'FRAME', 'COMPONENT', 'BOOLEAN_OPERATION', ...VECTOR_TYPES]);
const MAX_VECTOR_LAYERS = 400;

/** Whether a layer is best written as one <svg>: a vector shape, or a group or frame holding only
 *  shapes with at least one that CSS cannot draw (an icon). Text, pictures, instances, component
 *  properties and prototype links keep a layer out, as they need elements of their own. */
export function isVectorGraphic(doc: DesignDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  if (!node) return false;
  // A property that only shows or hides the layer becomes a condition around its element
  // (`{showIcon && <svg…/>}`), so the layer stays one <svg>; text and swap properties need elements of their own.
  if (needsSvg(node)) return !node.componentPropertyReferences?.characters && !node.componentPropertyReferences?.mainComponent;
  if (!(node.type === 'GROUP' || node.type === 'FRAME' || node.type === 'COMPONENT') || !node.children?.length) return false;
  // A frame that paints its own box (a filled checkbox, a coloured badge) is a box holding an icon, not an icon: the box
  // stays an element in every variant, so variants with and without the icon line up.
  if (node.type !== 'GROUP' && (node.fills.some(isVisiblePaint) || node.strokes.some(isVisiblePaint) || node.effects.some(e => e.visible !== false))) return false;
  let count = 0, vector = false;
  const stack = [...node.children];
  while (stack.length) {
    const child = doc.nodes[stack.pop()!];
    if (!child || !child.visible) continue;
    if (++count > MAX_VECTOR_LAYERS) return false;
    if (!PAINTED.has(child.type) || child.componentPropertyReferences || child.reactions.length || child.isMask) return false;
    if (child.fills.some(p => p.type === 'IMAGE' && isVisiblePaint(p))) return false;
    if (child.type === 'FRAME' && child.autoLayout && child.autoLayout.layoutMode !== 'NONE') return false;
    if (needsSvg(child)) vector = true;
    if (child.children && child.type !== 'BOOLEAN_OPERATION') stack.push(...child.children);
  }
  return vector && !node.fills.some(p => p.type === 'IMAGE' && isVisiblePaint(p));
}

/** How far a layer may paint past its box: strokes, arrowheads, shadows and blurs, generously. */
function reach(doc: DesignDocument, node: SceneNode): number {
  let most = 0;
  const stack: SceneNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    most = Math.max(most, n.strokeWeight * 4 + 8);
    // A text on a path stands its glyphs off its path's box.
    if (n.textPath && n.text) most = Math.max(most, n.text.style.fontSize * 2 * (n.text.characters.split('\n').length));
    for (const e of n.effects) {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') most = Math.max(most, e.radius * 2 + Math.abs(e.spread) + Math.abs(e.offset.x) + Math.abs(e.offset.y));
      else most = Math.max(most, e.radius * 2);
    }
    for (const id of n.children ?? []) {
      const child = doc.nodes[id];
      if (child) stack.push(child);
    }
  }
  return Math.ceil(most + 8);
}

const FALLBACK_MEASURER: TextMeasurer = {width: (text, font) => text.length * font.size * 0.55, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** The layer as inline SVG, placed in its parent's space. Null when it paints nothing. */
export function inlineSvg(doc: DesignDocument, id: NodeId, options: {measurer?: TextMeasurer; imageData?: (ref: ImageRef) => string | undefined; idPrefix?: string} = {}): InlineSvg | null {
  const node = doc.nodes[id];
  if (!node) return null;
  const local: Rect = {x: 0, y: 0, width: node.width, height: node.height};
  let box = turned(node) || node.flipX || node.flipY ? transformRect(localMatrix(node), local) : {x: node.x, y: node.y, width: node.width, height: node.height};
  // A viewBox with no width or height draws nothing: a straight line gets the thickness of its stroke.
  const pad = Math.max(1, node.strokeWeight / 2);
  if (box.width < 1) box = {...box, x: box.x - pad, width: box.width + pad * 2};
  if (box.height < 1) box = {...box, y: box.y - pad, height: box.height + pad * 2};
  let margin = reach(doc, node);
  for (let attempt = 0; attempt < 4; attempt++, margin *= 4) {
    const pageId = '\u0000codegen-page', frameId = '\u0000codegen-frame';
    const frame = createNode('RECTANGLE', {id: frameId, parentId: pageId, x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2, fills: [], strokes: [], effects: []});
    const page = createNode('PAGE', {id: pageId, children: [frameId, id]});
    // Lookups fall through to the document; only the page, the frame and the layer are new.
    const nodes: Record<NodeId, SceneNode> = Object.create(doc.nodes);
    nodes[pageId] = page;
    nodes[frameId] = frame;
    nodes[id] = {...node, parentId: pageId, isMask: false, visible: true};
    const markup = exportSvg({...doc, pages: [pageId], nodes}, [frameId, id], {measurer: options.measurer ?? FALLBACK_MEASURER, imageData: options.imageData});
    const root = parseSvg(markup);
    if (!root) return null;
    const width = Number(attr(root, 'width')), height = Number(attr(root, 'height'));
    if (Math.abs(width - frame.width) > 0.01 || Math.abs(height - frame.height) > 0.01) continue;
    if (!root.children.length) return null;
    prefixIds(root, options.idPrefix ?? 'svg');
    const monochrome = toCurrentColor(root);
    shiftOrigin(root, margin);
    return {root, box, viewBox: `0 0 ${num(box.width, 3)} ${num(box.height, 3)}`, monochrome};
  }
  return null;
}

const attr = (node: SvgNode, name: string) => node.attrs.find(([key]) => key === name)?.[1];

const NUMBER = '(-?[0-9.]+(?:e-?[0-9]+)?)';
const TRANSLATE = new RegExp(`^translate\\(${NUMBER}(?:[ ,]+${NUMBER})?\\)$`);
const MATRIX = new RegExp(`^matrix\\(${NUMBER}[ ,]+${NUMBER}[ ,]+${NUMBER}[ ,]+${NUMBER}[ ,]+${NUMBER}[ ,]+${NUMBER}\\)$`);

/** Moves the picture so the layer's box starts at 0,0 (the viewBox then reads "0 0 w h"): each top-level
 *  element's own translation absorbs the margin, and a group left with no transform melts away. Gradients,
 *  clips and filters live in the user space of the elements that use them, so they move along. */
function shiftOrigin(root: SvgNode, margin: number) {
  const f = (value: number) => num(value, 3);
  const shifted: (SvgNode | string)[] = [];
  for (const child of root.children) {
    if (typeof child === 'string' || child.tag === 'defs') {
      shifted.push(child);
      continue;
    }
    const transform = attr(child, 'transform');
    const rest = child.attrs.filter(([key]) => key !== 'transform');
    let next: string | null;
    const translate = transform ? TRANSLATE.exec(transform) : null;
    const matrix = transform ? MATRIX.exec(transform) : null;
    if (!transform) next = `translate(${f(-margin)} ${f(-margin)})`;
    else if (translate) {
      const x = Number(translate[1]) - margin, y = Number(translate[2] ?? 0) - margin;
      next = Math.abs(x) < 5e-4 && Math.abs(y) < 5e-4 ? null : `translate(${f(x)} ${f(y)})`;
    } else if (matrix) {
      const [a, b, c, d, e, g] = matrix.slice(1).map(Number);
      next = `matrix(${[a, b, c, d].map(v => num(v, 6)).join(' ')} ${f(e - margin)} ${f(g - margin)})`;
    } else {
      shifted.push({tag: 'g', attrs: [['transform', `translate(${f(-margin)} ${f(-margin)})`]], children: [child]});
      continue;
    }
    if (next === null && child.tag === 'g' && !rest.length) {
      shifted.push(...child.children);
      continue;
    }
    child.attrs = next === null ? rest : [...rest, ['transform', next]];
    shifted.push(child);
  }
  root.children = shifted;
}

// ── A small reader for the exporter's own, well-formed output ──────────────────────────────────

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
  if (code[0] === '#') {
    const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : '';
  }
  return Object.hasOwn(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()]! : whole;
});

/** Parses SVG markup as svg-export.ts writes it (elements, double-quoted attributes, text). */
export function parseSvg(markup: string): SvgNode | null {
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  const attrPattern = /([\w:.-]+)="([^"]*)"/g;
  const stack: SvgNode[] = [];
  let root: SvgNode | null = null;
  let last = 0;
  for (let match = tag.exec(markup); match; match = tag.exec(markup)) {
    const text = markup.slice(last, match.index);
    if (text && stack.length) stack[stack.length - 1].children.push(decode(text));
    last = match.index + match[0].length;
    const [, closing, name, rawAttrs, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: [string, string][] = [];
    for (let a = attrPattern.exec(rawAttrs); a; a = attrPattern.exec(rawAttrs)) attrs.push([a[1], decode(a[2])]);
    attrPattern.lastIndex = 0;
    const element: SvgNode = {tag: name, attrs, children: []};
    if (stack.length) stack[stack.length - 1].children.push(element);
    else root ??= element;
    if (!selfClosing) stack.push(element);
  }
  return root;
}

function walk(node: SvgNode, visit: (node: SvgNode) => void) {
  visit(node);
  for (const child of node.children) if (typeof child !== 'string') walk(child, visit);
}

/** Definition ids get the component's prefix, so two pictures on one page never share a gradient. */
function prefixIds(root: SvgNode, prefix: string) {
  const ids = new Set<string>();
  walk(root, node => {
    const id = attr(node, 'id');
    if (id) ids.add(id);
  });
  if (!ids.size) return;
  const rename = (id: string) => (ids.has(id) ? `${prefix}-${id}` : id);
  walk(root, node => {
    node.attrs = node.attrs.map(([key, value]): [string, string] => {
      if (key === 'id') return [key, rename(value)];
      if ((key === 'href' || key === 'xlink:href') && value.startsWith('#')) return [key, '#' + rename(value.slice(1))];
      return [key, value.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${rename(id)})`)];
    });
  });
}

const COLOR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'color']);

/** A one-colour picture (an icon) draws with currentColor, so CSS `color` themes it. */
function toCurrentColor(root: SvgNode): string | null {
  let only: string | null = null, mixed = false;
  walk(root, node => {
    if (node.tag === 'image' || node.tag === 'linearGradient' || node.tag === 'radialGradient' || node.tag === 'pattern') mixed = true;
    for (const [key, value] of node.attrs) {
      if (!COLOR_ATTRS.has(key) || value === 'none' || value === 'transparent' || value === 'currentColor') continue;
      if (value.startsWith('url(')) { mixed = true; continue; }
      const normal = value.toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(normal)) { mixed = true; continue; }
      if (only === null) only = normal;
      else if (only !== normal) mixed = true;
    }
  });
  if (mixed || !only) return null;
  // Flood colours of shadows stay what they are; the shapes take the text colour.
  walk(root, node => {
    if (node.tag === 'feFlood') return;
    node.attrs = node.attrs.map(([key, value]): [string, string] => (COLOR_ATTRS.has(key) && value.toUpperCase() === only ? [key, 'currentColor'] : [key, value]));
  });
  return only;
}

// ── JSX ────────────────────────────────────────────────────────────────────────────────────────

const camel = (name: string) => name.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase());

function jsxAttribute(key: string, value: string): string | null {
  if (key === 'xmlns' || key === 'xmlns:xlink') return null;
  if (key === 'xlink:href') return `href=${JSON.stringify(value)}`;
  if (key === 'class') return `className=${JSON.stringify(value)}`;
  if (key === 'style') {
    const entries = value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const colon = part.indexOf(':');
      return colon > 0 ? `${camel(part.slice(0, colon).trim())}: ${JSON.stringify(part.slice(colon + 1).trim())}` : null;
    }).filter(Boolean);
    return entries.length ? `style={{${entries.join(', ')}}}` : null;
  }
  const name = key.startsWith('data-') || key.startsWith('aria-') ? key : key === 'xml:space' ? 'xmlSpace' : camel(key);
  return `${name}=${JSON.stringify(value)}`;
}

const jsxTextValue = (text: string) => `{${JSON.stringify(text)}}`;

/** The picture's children as JSX lines at `indent`, inside an `<svg fill="none">`: a `fill="none"` an element inherits
 *  anyway is left out (stroked icons read as `<path d=… stroke=…/>`). */
export function svgChildrenJsx(root: SvgNode, indent: string): string[] {
  const lines: string[] = [];
  const write = (node: SvgNode, pad: string, fill: string) => {
    const own = node.attrs.find(([key]) => key === 'fill')?.[1];
    const attrs = node.attrs.filter(([key, value]) => !(key === 'fill' && value === 'none' && fill === 'none')).map(([key, value]) => jsxAttribute(key, value)).filter(Boolean).join(' ');
    const open = `<${node.tag}${attrs ? ' ' + attrs : ''}`;
    if (!node.children.length) {
      lines.push(`${pad}${open} />`);
      return;
    }
    if (node.children.every(child => typeof child === 'string')) {
      lines.push(`${pad}${open}>${node.children.map(child => jsxTextValue(child as string)).join('')}</${node.tag}>`);
      return;
    }
    lines.push(`${pad}${open}>`);
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child.trim()) lines.push(`${pad}  ${jsxTextValue(child)}`);
      } else write(child, pad + '  ', own ?? fill);
    }
    lines.push(`${pad}</${node.tag}>`);
  };
  for (const child of root.children) if (typeof child !== 'string') write(child, indent, 'none');
  return lines;
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The picture as an .svg file: the layer's box, a one-colour picture in `currentColor` (as the code draws it). */
export function svgMarkup(svg: InlineSvg): string {
  const write = (node: SvgNode | string): string => {
    if (typeof node === 'string') return escapeXml(node);
    const attrs = node.attrs.map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
    return node.children.length ? `<${node.tag}${attrs}>${node.children.map(write).join('')}</${node.tag}>` : `<${node.tag}${attrs}/>`;
  };
  const xlink = JSON.stringify(svg.root).includes('xlink:') ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${num(svg.box.width, 3)}" height="${num(svg.box.height, 3)}" viewBox="${svg.viewBox}" fill="none">${svg.root.children.map(write).join('')}</svg>\n`;
}

/** The whole <svg> as a string, for comparing two pictures. */
export function svgKey(svg: InlineSvg): string {
  return JSON.stringify([svg.root.children, svg.viewBox, svg.box.width, svg.box.height]);
}
