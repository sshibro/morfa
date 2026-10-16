// Layer specs (shared/design/canvas-tools.ts CanvasNodeSpec) as nodes of a document: auto layouts, text properties, paints and the
// sizing that has to hold where each layer stands. No DOM.
import {createNode, defaultAutoLayout, defaultTextProps, defaultTextStyle, solid} from '../../../shared/design/defaults';
import type {CanvasLayout, CanvasNodeSpec} from '../../../shared/design/canvas-tools';
import {sizingFixes} from '../../../shared/design/layout';
import type {AutoLayout, NodeId, Paint, RGB, SceneNode, TextProps} from '../../../shared/design/types';

/** "#RRGGBB" or "#RRGGBBAA" as a colour and its alpha. */
function parseHex(hex: string): {color: RGB; alpha: number} {
  const n = (from: number) => parseInt(hex.slice(from, from + 2), 16) / 255;
  return {color: {r: n(1), g: n(3), b: n(5)}, alpha: hex.length === 9 ? Math.round(n(7) * 1000) / 1000 : 1};
}
export const hexPaint = (hex: string): Paint => {
  const {color: rgb, alpha} = parseHex(hex);
  return solid(rgb, alpha);
};

/** The grey a picture placeholder shows until a picture is put in it. */
const PLACEHOLDER = '#E6E6E6';

/** A spec's auto layout as the document's (also how `update_layers` sets one). */
export function autoLayoutOf(layout: CanvasLayout): AutoLayout {
  return {
    ...defaultAutoLayout(layout.mode),
    layoutWrap: layout.wrap && layout.mode === 'HORIZONTAL' ? 'WRAP' : 'NO_WRAP',
    primaryAxisAlignItems: layout.primaryAlign,
    counterAxisAlignItems: layout.counterAlign,
    paddingTop: layout.padding.top,
    paddingRight: layout.padding.right,
    paddingBottom: layout.padding.bottom,
    paddingLeft: layout.padding.left,
    itemSpacing: layout.gap,
    counterAxisSpacing: layout.wrap ? layout.gap : 0,
  };
}

function textOf(spec: CanvasNodeSpec): TextProps {
  const t = spec.text!;
  const hug = spec.sizing?.horizontal === 'HUG' || (!spec.sizing && !t.characters.includes('\n') && t.characters.length <= 32);
  return {
    ...defaultTextProps(t.characters),
    style: {
      ...defaultTextStyle(),
      fontFamily: t.fontFamily,
      fontWeight: t.fontWeight,
      fontSize: t.fontSize,
      lineHeight: t.lineHeight === null ? {unit: 'AUTO'} : {unit: 'PIXELS', value: t.lineHeight},
      letterSpacing: {unit: 'PERCENT', value: t.letterSpacing ?? 0},
    },
    textAlignHorizontal: t.align,
    textAutoResize: spec.sizing?.vertical === 'FIXED' && spec.sizing.horizontal === 'FIXED' ? 'NONE' : hug ? 'WIDTH_AND_HEIGHT' : 'HEIGHT',
  };
}

/** One spec as a node of the document (not yet placed: `parentId`, `x`, `y` are the caller's). */
function nodeFromSpec(spec: CanvasNodeSpec, id: NodeId, parentId: NodeId): SceneNode {
  const base = {id, parentId, name: spec.name, x: spec.x, y: spec.y, width: spec.width, height: spec.height, opacity: spec.opacity ?? 1};
  const strokes = spec.stroke && spec.stroke.weight > 0 ? {strokes: [hexPaint(spec.stroke.color)], strokeWeight: spec.stroke.weight} : {};
  const fills = spec.fill ? [hexPaint(spec.fill)] : [];
  const sizing = spec.sizing ? {layoutSizingHorizontal: spec.sizing.horizontal, layoutSizingVertical: spec.sizing.vertical} : {};
  switch (spec.type) {
    case 'FRAME':
      return createNode('FRAME', {
        ...base, ...strokes, ...sizing, fills,
        cornerRadius: spec.cornerRadius ?? 0,
        // A frame of a built screen is a container to arrange, not an artboard that hides what spills.
        clipsContent: spec.parent === null,
        ...(spec.layout ? {autoLayout: autoLayoutOf(spec.layout)} : {}),
      });
    case 'TEXT':
      return createNode('TEXT', {...base, ...sizing, fills: [hexPaint(spec.text!.color)], text: textOf(spec)});
    case 'ELLIPSE':
      return createNode('ELLIPSE', {...base, ...strokes, ...sizing, fills});
    case 'IMAGE':
      return createNode('RECTANGLE', {
        ...base, ...strokes, ...sizing,
        fills: [hexPaint(spec.fill ?? PLACEHOLDER)],
        cornerRadius: spec.cornerRadius ?? 0,
      });
    default:
      return createNode('RECTANGLE', {...base, ...strokes, ...sizing, fills, cornerRadius: spec.cornerRadius ?? 0});
  }
}

export type BuiltNodes = {
  /** Parents before children, each with its parent's id. */
  nodes: SceneNode[];
  /** The new ids of the top-level layers, in order. */
  roots: NodeId[];
  /** Each spec's local id → its node's new id (the result names every new layer back to the caller). */
  ids: ReadonlyMap<string, NodeId>;
};

/**
 * The specs as nodes: top-level ones under `parentId`, shifted by `offset`; children under their new parents. A parent that hugs its
 * main axis while a child fills it becomes fixed there (Figma's rule: a frame cannot take its size from a child that takes its size
 * from it), and each node's sizing is made to hold where it stands (`sizingFixes`).
 */
export function buildNodes(specs: readonly CanvasNodeSpec[], parent: SceneNode, offset: {x: number; y: number}, makeId: () => string): BuiltNodes {
  const ids = new Map<string, NodeId>();
  const byId = new Map<NodeId, SceneNode>();
  const nodes: SceneNode[] = [];
  const roots: NodeId[] = [];
  for (const spec of specs) {
    const id = makeId();
    ids.set(spec.id, id);
    const parentId = spec.parent === null ? parent.id : ids.get(spec.parent);
    if (!parentId) continue;
    let node = nodeFromSpec(spec, id, parentId);
    if (spec.parent === null) {
      node = {...node, x: Math.round(spec.x + offset.x), y: Math.round(spec.y + offset.y)};
      roots.push(id);
    }
    byId.set(id, node);
    nodes.push(node);
  }
  for (const [index, node] of nodes.entries()) {
    const owner = node.parentId === parent.id ? parent : byId.get(node.parentId!);
    if (!owner) continue;
    let fixed = node;
    const layout = owner.autoLayout;
    if (owner !== parent && layout && layout.layoutMode !== 'NONE') {
      const horizontal = layout.layoutMode === 'HORIZONTAL';
      const fillsMain = horizontal ? node.layoutSizingHorizontal === 'FILL' : node.layoutSizingVertical === 'FILL';
      const hugsMain = horizontal ? owner.layoutSizingHorizontal === 'HUG' : owner.layoutSizingVertical === 'HUG';
      if (fillsMain && hugsMain) {
        const ownerFixed = {...owner, ...(horizontal ? {layoutSizingHorizontal: 'FIXED' as const} : {layoutSizingVertical: 'FIXED' as const})};
        byId.set(owner.id, ownerFixed);
        const at = nodes.findIndex(entry => entry.id === owner.id);
        if (at >= 0) nodes[at] = ownerFixed;
      }
    }
    const patch = sizingFixes(fixed, byId.get(fixed.parentId!) ?? parent);
    if (patch) fixed = {...fixed, ...patch};
    byId.set(fixed.id, fixed);
    nodes[index] = fixed;
  }
  return {nodes, roots, ids};
}

/** The box the top-level specs span, in their own coordinates. */
export function specsBounds(specs: readonly CanvasNodeSpec[]): {x: number; y: number; width: number; height: number} | null {
  const top = specs.filter(spec => spec.parent === null);
  if (!top.length) return null;
  const x = Math.min(...top.map(spec => spec.x)), y = Math.min(...top.map(spec => spec.y));
  const right = Math.max(...top.map(spec => spec.x + spec.width)), bottom = Math.max(...top.map(spec => spec.y + spec.height));
  return {x, y, width: right - x, height: bottom - y};
}
