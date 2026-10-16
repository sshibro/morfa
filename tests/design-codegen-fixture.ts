import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import {addComponentProperty, bindProperty, createInstance, setInstanceProperty} from '../shared/design/components';
import {combineAsVariants, setVariantProperty} from '../shared/design/variants';
import {normalizeDocument} from '../shared/design/normalize';
import type {TextMeasurer} from '../shared/design/text-layout';

// A realistic file for the code generator's tests: two icons, a button set (size × state) with an
// icon toggle, an icon swap and a label, and a screen using three buttons with different props.

export const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.55, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

const WHITE = {r: 1, g: 1, b: 1};
const BLUE = {r: 13 / 255, g: 153 / 255, b: 1};
const DARK_BLUE = {r: 0, g: 123 / 255, b: 229 / 255};
const INK = {r: 30 / 255, g: 30 / 255, b: 30 / 255};

export function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

export const update = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>): DesignDocument => ({...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...partial}}});

function icon(doc: DesignDocument, id: string, name: string, d: string, x: number): DesignDocument {
  doc = add(doc, 'COMPONENT', {id, parentId: 'p', name, x, y: -100, width: 24, height: 24, fills: [], clipsContent: false});
  return add(doc, 'VECTOR', {
    id: `${id}-v`, parentId: id, name: 'Vector', x: 4, y: 4, width: 16, height: 16, fills: [], strokes: [solid(INK)], strokeWeight: 2, strokeCap: 'ROUND', strokeJoin: 'ROUND',
    vectorPaths: [{windingRule: 'NONZERO', commands: d === 'arrow'
      ? [{type: 'M', x: 0, y: 8}, {type: 'L', x: 16, y: 8}, {type: 'M', x: 9, y: 1}, {type: 'L', x: 16, y: 8}, {type: 'L', x: 9, y: 15}]
      : [{type: 'M', x: 8, y: 0}, {type: 'L', x: 8, y: 16}, {type: 'M', x: 0, y: 8}, {type: 'L', x: 16, y: 8}]}],
  });
}

function variant(doc: DesignDocument, id: string, size: 'Large' | 'Small', state: 'Normal' | 'Hover', x: number, y: number): DesignDocument {
  const large = size === 'Large';
  doc = add(doc, 'COMPONENT', {
    id, parentId: 'p', name: `Size=${size}, State=${state}`, x, y, width: large ? 140 : 110, height: large ? 48 : 32,
    fills: [solid(state === 'Hover' ? DARK_BLUE : BLUE)], cornerRadius: 8,
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
    autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 8, paddingLeft: large ? 24 : 16, paddingRight: large ? 24 : 16, paddingTop: large ? 12 : 8, paddingBottom: large ? 12 : 8, counterAxisAlignItems: 'CENTER', primaryAxisAlignItems: 'CENTER'},
  });
  doc = createInstance(doc, 'icon-arrow', {parentId: id, newId: `${id}-icon`}).doc;
  if (!large) doc = update(doc, `${id}-icon`, {width: 16, height: 16, overrides: ['width', 'height']});
  return add(doc, 'TEXT', {
    id: `${id}-label`, parentId: id, name: 'Label', width: 60, height: 20,
    fills: [solid(WHITE)], text: {...defaultTextProps('Buy'), style: {...defaultTextProps().style, fontSize: large ? 16 : 14, fontWeight: 600, lineHeight: {unit: 'PIXELS', value: large ? 24 : 20}}},
  });
}

/** The fixture file. Ids: icons `icon-arrow`/`icon-plus`, set `btn` (variants lg, sm, lgh, smh), screen `home`
 *  with instances `b1` (default), `b2` (small, "Learn more", plus icon), `b3` (no icon). */
export function buttonFile(): {doc: DesignDocument; keys: {showIcon: string; label: string; icon: string}} {
  let doc = createDocument('p', 'Home');
  doc = icon(doc, 'icon-arrow', 'Icon/Arrow', 'arrow', 0);
  doc = icon(doc, 'icon-plus', 'Icon/Plus', 'plus', 40);
  doc = variant(doc, 'lg', 'Large', 'Normal', 0, 0);
  doc = variant(doc, 'sm', 'Small', 'Normal', 0, 60);
  doc = variant(doc, 'lgh', 'Large', 'Hover', 160, 0);
  doc = variant(doc, 'smh', 'Small', 'Hover', 160, 60);
  doc = combineAsVariants(doc, ['lg', 'lgh', 'sm', 'smh'], 'btn').doc;
  doc = update(doc, 'btn', {name: 'Button'});
  const showIcon = addComponentProperty(doc, 'btn', {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
  doc = showIcon.doc;
  const label = addComponentProperty(doc, 'btn', {name: 'Label', type: 'TEXT', defaultValue: 'Buy'});
  doc = label.doc;
  const swap = addComponentProperty(doc, 'btn', {name: 'Glyph', type: 'INSTANCE_SWAP', defaultValue: 'icon-arrow'});
  doc = swap.doc;
  for (const id of ['lg', 'sm', 'lgh', 'smh']) {
    doc = bindProperty(doc, `${id}-icon`, 'visible', showIcon.key).doc;
    doc = bindProperty(doc, `${id}-icon`, 'mainComponent', swap.key).doc;
    doc = bindProperty(doc, `${id}-label`, 'characters', label.key).doc;
  }

  doc = add(doc, 'FRAME', {
    id: 'home', parentId: 'p', name: 'Home', x: 0, y: 300, width: 400, height: 300, fills: [solid(WHITE)],
    autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 16, paddingLeft: 32, paddingRight: 32, paddingTop: 32, paddingBottom: 32},
  });
  doc = add(doc, 'TEXT', {id: 'title', parentId: 'home', name: 'Heading', width: 200, height: 40, fills: [solid(INK)], text: {...defaultTextProps('Beans'), style: {...defaultTextProps().style, fontSize: 32, fontWeight: 700}}});
  doc = createInstance(doc, 'btn', {parentId: 'home', newId: 'b1'}).doc;
  doc = createInstance(doc, 'btn', {parentId: 'home', newId: 'b2'}).doc;
  doc = setVariantProperty(doc, 'b2', 'Size', 'Small').doc;
  doc = setInstanceProperty(doc, 'b2', label.key, 'Learn more').doc;
  doc = setInstanceProperty(doc, 'b2', swap.key, 'icon-plus').doc;
  doc = createInstance(doc, 'btn', {parentId: 'home', newId: 'b3'}).doc;
  doc = setInstanceProperty(doc, 'b3', showIcon.key, false).doc;
  doc = normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer});
  return {doc, keys: {showIcon: showIcon.key, label: label.key, icon: swap.key}};
}

/** The button file plus a product card that uses everything else: a picture, a text style, an effect
 *  style, colour and number variables with a dark mode the card picks, styled runs, a link, a list, a
 *  button instance and an absolutely placed badge. The card is `card`. */
export function showcaseFile(): DesignDocument {
  let {doc} = buttonFile();
  doc = {...doc, images: {...doc.images, img1: {url: '/uploads/dz-1.webp', width: 1200, height: 800, name: 'Bean photo.jpg'}}};
  doc.styles = {
    h2: {id: 'h2', type: 'TEXT', name: 'Headings/H2', description: '', text: {...defaultTextProps().style, fontSize: 24, fontWeight: 600, lineHeight: {unit: 'PIXELS', value: 32}, letterSpacing: {unit: 'PERCENT', value: -1}}},
    card: {id: 'card', type: 'EFFECT', name: 'Shadow/Card', description: '', effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.12}, offset: {x: 0, y: 8}, radius: 24, spread: 0, visible: true, blendMode: 'NORMAL'}]},
  };
  doc.variableCollections = {c1: {id: 'c1', name: 'Colors', modes: [{modeId: 'm1', name: 'Light'}, {modeId: 'm2', name: 'Dark'}], defaultModeId: 'm1', variableIds: ['bg', 'ink', 'gap']}};
  doc.variables = {
    bg: {id: 'bg', name: 'Surface/Card', collectionId: 'c1', type: 'COLOR', valuesByMode: {m1: {r: 1, g: 1, b: 1, a: 1}, m2: {r: 0.1, g: 0.1, b: 0.1, a: 1}}, description: ''},
    ink: {id: 'ink', name: 'Text/Primary', collectionId: 'c1', type: 'COLOR', valuesByMode: {m1: {r: 0.1, g: 0.1, b: 0.1, a: 1}, m2: {r: 1, g: 1, b: 1, a: 1}}, description: ''},
    gap: {id: 'gap', name: 'spacing/m', collectionId: 'c1', type: 'FLOAT', valuesByMode: {m1: 16, m2: 16}, description: ''},
  };
  doc.variableModes = {card: {c1: 'm2'}};
  const ink = {...solid({r: 1, g: 1, b: 1}), boundVariables: {color: {type: 'VARIABLE_ALIAS' as const, id: 'ink'}}};
  doc = add(doc, 'FRAME', {
    id: 'card', parentId: 'p', name: 'Product card', x: 500, y: 300, width: 320, height: 520, cornerRadius: 16,
    fills: [{...solid({r: 0.1, g: 0.1, b: 0.1}), boundVariables: {color: {type: 'VARIABLE_ALIAS', id: 'bg'}}}], effectStyleId: 'card', effects: doc.styles.card.effects!,
    autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16}, boundVariables: {itemSpacing: {type: 'VARIABLE_ALIAS', id: 'gap'}},
  });
  doc = add(doc, 'RECTANGLE', {id: 'photo', parentId: 'card', name: 'Bean photo', width: 288, height: 200, cornerRadius: 8, layoutSizingHorizontal: 'FILL', fills: [{type: 'IMAGE', imageRef: 'img1', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  doc = add(doc, 'TEXT', {id: 'name', parentId: 'card', name: 'Name', width: 288, height: 32, textStyleId: 'h2', fills: [ink], layoutSizingHorizontal: 'FILL', text: {...defaultTextProps('Ethiopia Yirgacheffe'), style: doc.styles.h2.text!, textAutoResize: 'HEIGHT'}});
  doc = add(doc, 'TEXT', {id: 'notes', parentId: 'card', name: 'Description', width: 288, height: 72, fills: [ink], layoutSizingHorizontal: 'FILL', text: {
    ...defaultTextProps('Notes: jasmine and bergamot. Learn more on the site\nAcidity: high\nBody: light'), textAutoResize: 'HEIGHT', listTypes: ['NONE', 'UNORDERED', 'UNORDERED'],
    runs: [{start: 7, end: 27, style: {fontWeight: 700}}, {start: 40, end: 51, style: {hyperlink: {type: 'URL', url: 'https://zerno.example'}, textDecoration: 'UNDERLINE'}}],
  }});
  doc = createInstance(doc, 'btn', {parentId: 'card', newId: 'buy'}).doc;
  doc = add(doc, 'FRAME', {id: 'badge', parentId: 'card', name: 'Badge', x: 236, y: 28, width: 60, height: 24, layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'MAX', vertical: 'MIN'}, fills: [solid({r: 1, g: 0.8, b: 0})], cornerRadius: 12,
    autoLayout: {...defaultAutoLayout('HORIZONTAL'), primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER'}});
  doc = add(doc, 'TEXT', {id: 'badge-t', parentId: 'badge', name: 'New', fills: [solid({r: 0, g: 0, b: 0})], text: {...defaultTextProps('New'), style: {...defaultTextProps().style, fontSize: 11, fontWeight: 600}}});
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer});
}
