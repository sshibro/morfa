import type {Annotation, AnnotationPropertyType, DesignDocument, NodeId, Paint, SceneNode} from './types';
import {FRAME_LIKE_TYPES} from './types';
import {color, letterSpacingCss, lineHeightCss, num, px} from './codegen/values';
import {wholeTextStyle} from './codegen/css';
import {newId} from './defaults';

// "Annotation" (Y; Figma Dev Mode annotations, docs/design-tool.md §Dev annotations and measurements): notes for developers
// pinned to a layer. A note has a text, an optional category (Figma's four presets with their colours) and properties of
// the layer it shows, read live from the layer, so a note that says "Width" always shows today's width. Pure reads.

export type AnnotationColor = 'yellow' | 'orange' | 'red' | 'pink' | 'violet' | 'blue' | 'teal' | 'green';
export type AnnotationCategory = {id: string; label: string; color: AnnotationColor};

/** Figma's preset categories (its custom categories are not here yet: docs/design-tool.md says so). */
export const ANNOTATION_CATEGORIES: readonly AnnotationCategory[] = [
  {id: 'development', label: 'Development', color: 'blue'},
  {id: 'interaction', label: 'Interaction', color: 'violet'},
  {id: 'accessibility', label: 'Accessibility', color: 'green'},
  {id: 'content', label: 'Content', color: 'orange'},
];

/** The colours of the canvas marks, the same in both themes (they stand on the design, not on the chrome). */
export const ANNOTATION_COLORS: Readonly<Record<AnnotationColor, string>> = {
  yellow: '#E5A000', orange: '#F07400', red: '#F24822', pink: '#E83D9A', violet: '#9747FF', blue: '#0D99FF', teal: '#00A3A3', green: '#14AE5C',
};
/** A note without a category. */
export const ANNOTATION_DEFAULT_COLOR = '#7A7A7A';

export const annotationCategory = (id: string | undefined) => (id ? ANNOTATION_CATEGORIES.find(category => category.id === id) ?? null : null);
export const annotationColor = (annotation: Pick<Annotation, 'categoryId'>) => {
  const category = annotationCategory(annotation.categoryId);
  return category ? ANNOTATION_COLORS[category.color] : ANNOTATION_DEFAULT_COLOR;
};

type PropertyEntry = {type: AnnotationPropertyType; label: string; group: 'size' | 'look' | 'text' | 'layout' | 'component'; applies(node: SceneNode): boolean};

const isText = (node: SceneNode) => node.type === 'TEXT' && !!node.text;
const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);
const hasAutoLayout = (node: SceneNode) => !!node.autoLayout && node.autoLayout.layoutMode !== 'NONE';
const hasCorners = (node: SceneNode) => node.cornerRadius !== undefined || !!node.rectangleCornerRadii;
const always = () => true;

/** The properties a note can show, in the order of Figma's menu, with where each applies. */
export const ANNOTATION_PROPERTIES: readonly PropertyEntry[] = [
  {type: 'width', label: 'Width', group: 'size', applies: always},
  {type: 'height', label: 'Height', group: 'size', applies: always},
  {type: 'minWidth', label: 'Min width', group: 'size', applies: node => node.minWidth != null},
  {type: 'maxWidth', label: 'Max width', group: 'size', applies: node => node.maxWidth != null},
  {type: 'minHeight', label: 'Min height', group: 'size', applies: node => node.minHeight != null},
  {type: 'maxHeight', label: 'Max height', group: 'size', applies: node => node.maxHeight != null},
  {type: 'fills', label: 'Fill', group: 'look', applies: node => node.type !== 'GROUP' && node.type !== 'SLICE'},
  {type: 'strokes', label: 'Stroke', group: 'look', applies: node => node.type !== 'GROUP' && node.type !== 'SLICE'},
  {type: 'strokeWeight', label: 'Stroke weight', group: 'look', applies: node => node.strokes.length > 0},
  {type: 'cornerRadius', label: 'Corner radius', group: 'look', applies: hasCorners},
  {type: 'effects', label: 'Effects', group: 'look', applies: node => node.type !== 'SLICE'},
  {type: 'opacity', label: 'Opacity', group: 'look', applies: always},
  {type: 'textStyleId', label: 'Text style', group: 'text', applies: isText},
  {type: 'fontFamily', label: 'Font', group: 'text', applies: isText},
  {type: 'fontStyle', label: 'Font style', group: 'text', applies: isText},
  {type: 'fontSize', label: 'Font size', group: 'text', applies: isText},
  {type: 'fontWeight', label: 'Font weight', group: 'text', applies: isText},
  {type: 'lineHeight', label: 'Line height', group: 'text', applies: isText},
  {type: 'letterSpacing', label: 'Letter spacing', group: 'text', applies: isText},
  {type: 'textAlignHorizontal', label: 'Text align', group: 'text', applies: isText},
  {type: 'layoutMode', label: 'Auto layout', group: 'layout', applies: isFrameLike},
  {type: 'itemSpacing', label: 'Gap', group: 'layout', applies: hasAutoLayout},
  {type: 'padding', label: 'Padding', group: 'layout', applies: hasAutoLayout},
  {type: 'alignItems', label: 'Alignment', group: 'layout', applies: hasAutoLayout},
  {type: 'mainComponent', label: 'Component', group: 'component', applies: node => node.type === 'INSTANCE'},
];
const PROPERTY_BY_TYPE = new Map(ANNOTATION_PROPERTIES.map(entry => [entry.type, entry]));
export const annotationPropertyLabel = (type: AnnotationPropertyType) => PROPERTY_BY_TYPE.get(type)?.label ?? type;
/** The properties that make sense on this layer (the note's "+ Property" menu). */
export const annotationPropertiesFor = (node: SceneNode) => ANNOTATION_PROPERTIES.filter(entry => entry.applies(node));

const paintText = (paints: readonly Paint[]): string => {
  const visible = paints.filter(paint => paint.visible !== false);
  if (!visible.length) return 'None';
  return visible.map(paint => {
    if (paint.type === 'SOLID') return color(paint.color, paint.opacity).toUpperCase();
    if (paint.type === 'IMAGE') return 'Image';
    return {GRADIENT_LINEAR: 'Linear gradient', GRADIENT_RADIAL: 'Radial gradient', GRADIENT_ANGULAR: 'Angular gradient', GRADIENT_DIAMOND: 'Diamond gradient'}[paint.type];
  }).join(', ');
};

const ALIGN_TEXT = {LEFT: 'Left', CENTER: 'Center', RIGHT: 'Right', JUSTIFIED: 'Justified'} as const;
const ALIGN_ITEMS = {MIN: 'Start', CENTER: 'Center', MAX: 'End', SPACE_BETWEEN: 'Space between', BASELINE: 'Baseline'} as const;

/** The value a note shows for a property of `node`, as the "Code" tab writes it. */
export function annotationValue(doc: DesignDocument, node: SceneNode, type: AnnotationPropertyType): string {
  const text = isText(node) ? wholeTextStyle(node) : null;
  const layout = node.autoLayout;
  switch (type) {
    case 'width': return px(node.width);
    case 'height': return px(node.height);
    case 'minWidth': return node.minWidth != null ? px(node.minWidth) : '—';
    case 'maxWidth': return node.maxWidth != null ? px(node.maxWidth) : '—';
    case 'minHeight': return node.minHeight != null ? px(node.minHeight) : '—';
    case 'maxHeight': return node.maxHeight != null ? px(node.maxHeight) : '—';
    case 'fills': return node.fillStyleId && doc.styles[node.fillStyleId] ? doc.styles[node.fillStyleId].name : paintText(text ? text.fills : node.fills);
    case 'strokes': return node.strokeStyleId && doc.styles[node.strokeStyleId] ? doc.styles[node.strokeStyleId].name : paintText(node.strokes);
    case 'strokeWeight': return px(node.strokeWeight);
    case 'cornerRadius': return node.rectangleCornerRadii ? node.rectangleCornerRadii.map(px).join(' ') : px(node.cornerRadius ?? 0);
    case 'effects': {
      if (node.effectStyleId && doc.styles[node.effectStyleId]) return doc.styles[node.effectStyleId].name;
      const visible = node.effects.filter(effect => effect.visible);
      if (!visible.length) return 'None';
      return visible.map(effect => ({DROP_SHADOW: 'Drop shadow', INNER_SHADOW: 'Inner shadow', LAYER_BLUR: 'Layer blur', BACKGROUND_BLUR: 'Background blur'}[effect.type])).join(', ');
    }
    case 'opacity': return `${num(node.opacity * 100)}%`;
    case 'textStyleId': return text?.styleId && doc.styles[text.styleId] ? doc.styles[text.styleId].name : 'None';
    case 'fontFamily': return text ? text.style.fontFamily : '—';
    case 'fontStyle': return text ? `${text.style.fontWeight}${text.style.italic ? ', italic' : ''}` : '—';
    case 'fontSize': return text ? px(text.style.fontSize) : '—';
    case 'fontWeight': return text ? String(text.style.fontWeight) : '—';
    case 'lineHeight': return text ? lineHeightCss(text.style.lineHeight) ?? 'Auto' : '—';
    case 'letterSpacing': return text ? letterSpacingCss(text.style.letterSpacing) ?? '0' : '—';
    case 'textAlignHorizontal': return node.text ? ALIGN_TEXT[node.text.textAlignHorizontal] : '—';
    case 'layoutMode': return !layout || layout.layoutMode === 'NONE' ? 'None' : layout.layoutMode === 'VERTICAL' ? 'Vertical' : layout.layoutWrap === 'WRAP' ? 'Horizontal, wrap' : 'Horizontal';
    case 'itemSpacing': return layout ? (layout.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'Auto' : px(layout.itemSpacing)) : '—';
    case 'padding': {
      if (!layout) return '—';
      const sides = [layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft].map(px);
      return sides.every(side => side === sides[0]) ? sides[0] : sides.join(' ');
    }
    case 'alignItems': return layout ? `${ALIGN_ITEMS[layout.primaryAxisAlignItems]} · ${ALIGN_ITEMS[layout.counterAxisAlignItems]}` : '—';
    case 'mainComponent': {
      const main = node.componentId ? doc.nodes[node.componentId] : undefined;
      return main ? main.name : 'None';
    }
  }
}

/** A new note's id: random, so two people pinning a note on one layer at once never pick the same id (co-editing merges
 *  the list by id, shared/design/merge.ts), and unique on its layer. */
export function newAnnotationId(existing: readonly Annotation[] = []): string {
  const taken = new Set(existing.map(annotation => annotation.id));
  for (;;) {
    const id = `a${newId()}`;
    if (!taken.has(id)) return id;
  }
}

/** Every note of the page's layers, in paint order (what "Code" lists for developers). */
export function pageAnnotations(doc: DesignDocument, pageId: NodeId): {node: SceneNode; annotation: Annotation}[] {
  const out: {node: SceneNode; annotation: Annotation}[] = [];
  const stack = [...(doc.nodes[pageId]?.children ?? [])].reverse();
  let guard = 0;
  while (stack.length && guard++ < 1_000_000) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    for (const annotation of node.annotations ?? []) out.push({node, annotation});
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}
