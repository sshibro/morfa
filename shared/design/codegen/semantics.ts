import type {DesignDocument, NodeId, SceneNode} from '../types';
import {isAutoLayout} from '../constraints';
import {wholeTextStyle} from './css';
import {holdsInteractive, isButtonLike} from './model';
import {isContentName, isDefaultLayerName, memberName} from './names';

// What the layers are for, as HTML and as names: which texts are headings and at what level, and what a class
// is called when the layer's own name says nothing (a text named by its content, a "Frame 12").

const STYLE_LEVEL = /(?:^|[^a-zа-я0-9])(?:h|heading|title|display|заголовок)\s*-?\s*([1-6])(?![0-9])/i;
const STYLE_HEADING = /(heading|title|display|headline|заголов|h[1-6](?![0-9]))/i;
/** Text styles that sit beside a heading without being one: the line above it, the line under it. */
const STYLE_BESIDE_HEADING = /(надзаголов|подзаголов|overline|eyebrow|kicker|subtitle|subheading)/i;
/** A logo's wordmark (and a row of client logos) is a picture of a name, never a heading. */
const LOGO_NAME = /(logo|логотип)/i;

/** A text that can be a heading: a phrase of words, not a number, an initial or a paragraph. */
function headingCandidate(node: SceneNode): boolean {
  const text = node.text?.characters.trim() ?? '';
  if (text.length < 3 || text.length > 120 || text.includes('\n')) return false;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters >= 3 && letters >= text.replace(/\s/g, '').length / 2;
}

function styleName(doc: DesignDocument, node: SceneNode): string | null {
  const {styleId} = wholeTextStyle(node);
  return styleId ? doc.styles[styleId]?.name ?? null : null;
}

/** Heading levels of the texts under `rootId`. A text style named "H2" or "Heading/2" gives its level; on a screen a big,
 *  bold text without one ranks by size among the others. The screen's outline starts at h1 and never goes more than one
 *  level deeper than the heading before it; a component's texts are headings only when their style says so (where it is
 *  used decides the outline), and a screen leaves the texts of the components in it to them. Texts inside buttons, links
 *  and logos are never headings, nor are the lines above and under one ("Overline", "Subheading"). */
export function headingLevels(doc: DesignDocument, rootId: NodeId, screen: boolean): Map<NodeId, number> {
  const out = new Map<NodeId, number>();
  const found: {id: NodeId; level: number | null; size: number}[] = [];
  const walk = (id: NodeId, interactive: boolean, depth: number) => {
    const node = doc.nodes[id];
    if (!node || node.visible === false || depth > 64) return;
    if ((node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && depth > 0) return;
    // A text layer called "Button" is a button's label in a UI kit's list, not a button.
    const inside = interactive || (depth > 0 && node.type !== 'TEXT' && ((isButtonLike(node) && !holdsInteractive(doc, node)) || LOGO_NAME.test(node.name))) || node.reactions.some(reaction => reaction.actions.some(action => action.type === 'URL'));
    if (node.type === 'TEXT' && node.text && !inside && !node.text.characters.trim().startsWith('http') && headingCandidate(node)) {
      const style = wholeTextStyle(node).style;
      const named = styleName(doc, node);
      const level = named ? STYLE_LEVEL.exec(named)?.[1] : undefined;
      if (level) found.push({id, level: Number(level), size: style.fontSize});
      else if (named ? STYLE_HEADING.test(named) && !STYLE_BESIDE_HEADING.test(named) : screen && (style.fontSize >= 24 || (style.fontSize >= 20 && style.fontWeight >= 600))) found.push({id, level: null, size: style.fontSize});
    }
    for (const child of node.children ?? []) walk(child, inside, depth + 1);
  };
  walk(rootId, false, 0);
  if (!found.length) return out;
  // Unnumbered headings rank by size among all of them, and always below a numbered heading that is bigger (a 22px name
  // under an "H1" style is a level lower, never a second h1).
  const sizes = [...new Set(found.map(entry => entry.size))].sort((a, b) => b - a);
  const numbered = found.filter(entry => entry.level !== null);
  for (const entry of found) {
    if (entry.level !== null) continue;
    const above = numbered.filter(other => other.size > entry.size).reduce((most, other) => Math.max(most, other.level!), 0);
    entry.level = Math.min(6, Math.max(sizes.indexOf(entry.size) + 1, above + 1));
  }
  if (screen) {
    // Close the gaps: levels in use become 1, 2, 3… in their order. Then, in reading order, a heading goes at most one level
    // deeper than the one before it (an h3 never follows the h1 directly), and headings of one rank keep the level the first
    // of them got (the sections of a page are all h2).
    const used = [...new Set(found.map(entry => entry.level!))].sort((a, b) => a - b);
    const given = new Map<number, number>();
    let previous = 0;
    for (const entry of found) {
      const rank = used.indexOf(entry.level!) + 1;
      const level = Math.min(given.get(rank) ?? rank, previous + 1);
      if (!given.has(rank)) given.set(rank, level);
      out.set(entry.id, level);
      previous = level;
    }
  } else for (const entry of found) out.set(entry.id, entry.level!);
  return out;
}

// ── Names ──────────────────────────────────────────────────────────────────────────────────────

/** Whether a layer's name says what it is for: not a default name, not the text it shows, not a variant's "Type=…". */
export function meaningfulName(node: SceneNode): boolean {
  if (isDefaultLayerName(node.name, node.type)) return false;
  if (node.type === 'TEXT' && node.text && isContentName(node.name, node.text.characters)) return false;
  if (node.name.includes('=')) return false;
  return !!memberName(node.name, '');
}

/** A layer that is the root of what is written (a component, a variant, a frame on the page): its name is the file's, not a prefix. */
const isOutputRoot = (doc: DesignDocument, node: SceneNode) => node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || !node.parentId || doc.nodes[node.parentId]?.type === 'PAGE';

/** The camelCase class name of a layer: its own name when that says something, else its role. */
export function classBaseOf(doc: DesignDocument, node: SceneNode, tag: string): string {
  if (node.type === 'INSTANCE' && !meaningfulName(node)) {
    // An instance left with its component's name (or a default one) is named after the component.
    const main = node.componentId ? doc.nodes[node.componentId] : undefined;
    const set = main?.parentId && doc.nodes[main.parentId]?.type === 'COMPONENT_SET' ? doc.nodes[main.parentId] : main;
    if (set && memberName(set.name, '')) return memberName(set.name);
  }
  if (meaningfulName(node)) return memberName(node.name, 'layer');
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const prefix = parent && !isOutputRoot(doc, parent) && meaningfulName(parent) && !/^(root|layer)$/.test(memberName(parent.name)) ? memberName(parent.name) : '';
  const role = roleOf(doc, node, parent, tag);
  if (!prefix) return role;
  // "Name" holding a title and a subtitle: nameTitle, nameSubtitle; a lone text in "Price": priceText.
  return prefix === role ? role : prefix + role[0].toUpperCase() + role.slice(1);
}

function roleOf(doc: DesignDocument, node: SceneNode, parent: SceneNode | undefined, tag: string): string {
  if (node.type === 'TEXT') {
    if (/^h[1-6]$/.test(tag)) return 'title';
    const texts = (parent?.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.type === 'TEXT' && child.visible !== false);
    // The one text of a button, a link, a tag or a chip is its label.
    if (texts.length === 1 && parent && (isButtonLike(parent) || isOutputRoot(doc, parent) || parent.reactions.some(reaction => reaction.actions.some(action => action.type === 'URL')))) return 'label';
    if (parent && texts.length === 2 && isAutoLayout(parent)) {
      const first = texts[0].id === node.id;
      if (parent.autoLayout!.layoutMode === 'VERTICAL') return first ? 'title' : 'subtitle';
      return first ? 'label' : 'value';
    }
    return 'text';
  }
  if (node.type === 'INSTANCE') return 'item';
  if (node.type === 'LINE' || ((node.type === 'RECTANGLE' || node.type === 'FRAME') && !node.children?.length && Math.min(node.width, node.height) <= 2)) return 'divider';
  if (node.fills.some(paint => paint.type === 'IMAGE' && paint.visible !== false)) return 'image';
  if (node.type === 'ELLIPSE') return 'circle';
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'POLYGON') return 'icon';
  if (isAutoLayout(node)) return node.autoLayout!.layoutMode === 'GRID' ? 'grid' : node.autoLayout!.layoutMode === 'VERTICAL' ? 'stack' : 'row';
  if (node.type === 'GROUP') return 'group';
  if (node.type === 'RECTANGLE') return 'shape';
  return 'box';
}
