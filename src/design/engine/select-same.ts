import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {forEachDescendant} from '../../../shared/design/tree';

// "Select all with same" (Figma's Edit ▸ Select all with same …): every visible, unlocked layer of the page whose fill,
// stroke, effects, text properties, font or main component is one of the selected layers'. A layer with a style shares it
// through the style; one without (no fill, not a text, not an instance) gives nothing to match. Outermost matches only,
// as "Select similar layers": a match's own children are not added.

export type SameKind = 'fill' | 'stroke' | 'effect' | 'text' | 'font' | 'instance';

export const SAME_LABELS: Record<SameKind, string> = {
  fill: 'Same fill',
  stroke: 'Same stroke',
  effect: 'Same effects',
  text: 'Same text properties',
  font: 'Same font',
  instance: 'Same component',
};

const visible = <T extends {visible?: boolean}>(items: readonly T[]) => items.filter(item => item.visible !== false);

/** What a layer is matched by for `kind`, or null when it has nothing of that kind. */
export function sameSignature(node: SceneNode, kind: SameKind): string | null {
  switch (kind) {
    case 'fill':
      if (node.fillStyleId) return 'style:' + node.fillStyleId;
      return visible(node.fills).length ? JSON.stringify(visible(node.fills)) : null;
    case 'stroke':
      if (!visible(node.strokes).length) return null;
      return JSON.stringify([node.strokeStyleId ?? visible(node.strokes), node.strokeWeight]);
    case 'effect':
      if (node.effectStyleId) return 'style:' + node.effectStyleId;
      return visible(node.effects).length ? JSON.stringify(visible(node.effects)) : null;
    case 'text': {
      if (node.type !== 'TEXT' || !node.text) return null;
      if (node.textStyleId) return 'style:' + node.textStyleId;
      const {fontFamily, fontWeight, italic, fontSize, lineHeight, letterSpacing} = node.text.style;
      return JSON.stringify([fontFamily, fontWeight, italic, fontSize, lineHeight, letterSpacing]);
    }
    case 'font': {
      if (node.type !== 'TEXT' || !node.text) return null;
      const {fontFamily, fontWeight, italic} = node.text.style;
      return JSON.stringify([fontFamily, fontWeight, italic]);
    }
    case 'instance':
      return node.type === 'INSTANCE' && node.componentId ? node.componentId : null;
  }
}

/** Whether the selection has anything to match for `kind` (the command is enabled). */
export function canSelectSame(doc: DesignDocument, selection: readonly NodeId[], kind: SameKind): boolean {
  return selection.some(id => {
    const node = doc.nodes[id];
    return !!node && node.type !== 'PAGE' && sameSignature(node, kind) !== null;
  });
}

/** The page's layers matching any selected layer for `kind`; the selection itself when it has nothing to match. */
export function selectSame(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[], kind: SameKind): NodeId[] {
  const signatures = new Set<string>();
  for (const id of selection) {
    const node = doc.nodes[id];
    const signature = node && node.type !== 'PAGE' ? sameSignature(node, kind) : null;
    if (signature !== null) signatures.add(signature);
  }
  if (!signatures.size) return [...selection];
  const out: NodeId[] = [];
  forEachDescendant(doc, pageId, node => {
    if (!node.visible || node.locked) return false;
    const signature = sameSignature(node, kind);
    if (signature !== null && signatures.has(signature)) {
      out.push(node.id);
      return false;
    }
    return undefined;
  });
  return out;
}
