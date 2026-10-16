import type {DesignDocument, Hyperlink, NodeId, Paint, SceneNode, TextStyle} from '../types';
import {variantValues} from '../components';
import {declarations, suggestedColor, textPaintDecls, typographyDecls, wholeTextStyle, type Decl, type DeclContext} from './css';
import {fieldParts, holdsInteractive, isButtonLike, optionLiteral, PRESS_TRIGGERS, stateApi, type ComponentModel, type PropDef} from './model';
import {isDefaultLayerName, slugName} from './names';
import {classBaseOf} from './semantics';
import {inlineSvg, isVectorGraphic, type InlineSvg} from './svg';
import {isVisiblePaint} from './values';

// The element tree of one component variant or screen: which tag draws each layer, its CSS
// declarations, attributes, children, and the props it reads. Semantic choices follow what the
// layer obviously is: headings from the screen's outline (semantics.ts), paragraphs and inline
// labels, "Button" or a click interaction → <button>, a link interaction or a text hyperlink
// → <a rel="noopener">, a picture-only rectangle → <img>, a text field → <label> and a real <input>,
// vectors → inline SVG icons, list paragraphs → ul/ol, instances → the component with props.

export type Attr = {name: string; value: string; expr: boolean};
export type Piece = {kind: 'text'; key: string; text: string} | {kind: 'expr'; key: string; expr: string} | {kind: 'br'; key: string};

/** A part of a text field: the input, its label, the hint under it, the box around the input. */
export type FieldRole = 'input' | 'label' | 'hint' | 'box';

export type El = {
  kind: 'el';
  /** Matches the same layer across variants: names and positions from the component root. */
  key: string;
  nodeId: NodeId;
  /** An HTML tag, a component's name (role component), an inline SVG (role svg). */
  tag: string;
  role: 'html' | 'component' | 'svg';
  /** The layer's name (names an inline SVG component). */
  name: string;
  /** Wanted class name (camelCase); the emitter makes it unique. Empty: a span named after its text. */
  classBase: string;
  decls: Decl[];
  attrs: Attr[];
  /** Props of a component usage. */
  props: Attr[];
  children: (El | Piece)[];
  /** A BOOLEAN property shows or hides the layer. */
  condition: string | null;
  svg?: InlineSvg;
  /** The component root: merges the `className`/`style` prop, and a button's `onClick`. */
  root?: boolean;
  /** A part of a text field, and the layer of the field it belongs to. */
  field?: FieldRole;
  fieldGroup?: NodeId;
  /** The text the layer shows (an input's placeholder comes from the default variant's). */
  text?: string;
};

export type BuildHost = {
  doc: DesignDocument;
  css: DeclContext;
  /** The React shape of a component (and a name for it); queues it for output. */
  component(nodeId: NodeId): ComponentModel;
  measurer?: import('../text-layout').TextMeasurer;
  warn(message: string): void;
  /** Heading levels of the texts being written (semantics.ts). */
  headings: ReadonlyMap<NodeId, number>;
};

export type BuildScope = {
  /** The component whose variant this is (null for a screen). */
  model: ComponentModel | null;
  /** Props read while building. */
  used: Set<string>;
  /** Parts of the text fields met so far, by layer: the part and the field's layer. */
  fields?: Map<NodeId, {role: FieldRole; group: NodeId}>;
};

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** A picture inside generated code before the emitter knows how its file is referenced. */
export const assetMark = (ref: string) => `\u0000asset:${ref}\u0000`;
export const ASSET_MARK = /\u0000asset:([^\u0000]*)\u0000/g;
/** Placeholder before a picture's definition ids get their component's prefix. */
export const SVG_ID_PREFIX = 'dzsvgid';
const LIST_TAG = {ORDERED: 'ol', UNORDERED: 'ul'} as const;

/** The component a node (an instance's target) belongs to: the set for a variant. */
export function componentRoot(doc: DesignDocument, id: NodeId | undefined): NodeId | null {
  const node = id ? doc.nodes[id] : undefined;
  if (!node) return null;
  if (node.type === 'COMPONENT_SET') return node.id;
  if (node.type !== 'COMPONENT') return null;
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  return parent?.type === 'COMPONENT_SET' ? parent.id : node.id;
}

function urlAction(node: SceneNode): {url: string; newTab: boolean} | null {
  for (const reaction of node.reactions) {
    if (!PRESS_TRIGGERS.has(reaction.trigger.type)) continue;
    for (const action of reaction.actions) if (action.type === 'URL' && SAFE_URL.test(action.url)) return {url: action.url, newTab: action.openInNewTab};
  }
  return null;
}

const linkAttrs = (url: string, newTab: boolean): Attr[] => [
  {name: 'href', value: url, expr: false},
  ...(newTab ? [{name: 'target', value: '_blank', expr: false}, {name: 'rel', value: 'noopener noreferrer', expr: false}] : []),
];

/** The variable modes a frame picked, as data attributes. */
function modeAttrs(host: BuildHost, node: SceneNode): Attr[] {
  const picked = host.doc.variableModes?.[node.id];
  if (!picked) return [];
  const out: Attr[] = [];
  for (const [collectionId, modeId] of Object.entries(picked)) {
    const attribute = host.css.tokens.modeAttributes.get(collectionId);
    const value = attribute?.modes.get(modeId);
    if (attribute && value) out.push({name: attribute.attribute, value, expr: false});
  }
  return out;
}

const isImageOnly = (node: SceneNode) => {
  if (node.type !== 'RECTANGLE' && !(node.type === 'FRAME' && !node.children?.length) && node.type !== 'ELLIPSE') return false;
  const visible = node.fills.filter(isVisiblePaint);
  return visible.length === 1 && visible[0].type === 'IMAGE' && !!visible[0].imageRef && visible[0].scaleMode !== 'TILE' && !node.strokes.some(isVisiblePaint);
};

/** Builds the element of `node` (null when nothing is drawn). `key` names it among its siblings. */
export function buildElement(host: BuildHost, scope: BuildScope, node: SceneNode, key: string, options: {root: boolean; inline: boolean}): El | null {
  if (node.type === 'SLICE' || node.type === 'PAGE') return null;
  const refs = node.componentPropertyReferences;
  const visibilityProp = refs?.visible ? propFor(scope, refs.visible, 'boolean') : null;
  if (!node.visible && !visibilityProp) return null;
  if (node.isMask) {
    host.warn(`Mask "${node.name}" is not carried over to CSS: the layers under it are shown in full.`);
    return null;
  }
  const condition = visibilityProp ? use(scope, visibilityProp) : null;
  const css: DeclContext = {...host.css, root: options.root};
  const base: Omit<El, 'tag' | 'role' | 'decls'> = {kind: 'el', key, nodeId: node.id, name: node.name, classBase: options.root ? 'root' : '', attrs: modeAttrs(host, node), props: [], children: [], condition, root: options.root};
  const named = (tag: string): string => base.classBase || classBaseOf(host.doc, node, tag);

  // A slot: an instance swapped through an INSTANCE_SWAP property renders the prop in its place.
  if (node.type === 'INSTANCE' && refs?.mainComponent && scope.model) {
    const slot = propFor(scope, refs.mainComponent, 'slot');
    if (slot) {
      const placement = declarations(node, css).filter(decl => decl.group === 'position' || decl.group === 'item' || decl.prop === 'width' || decl.prop === 'height');
      const slotName = use(scope, slot);
      // An optional slot (its show/hide boolean merged into it) renders only when given.
      const shown = slot.optional && !condition ? slotName : condition;
      return {...base, condition: shown, classBase: base.classBase || slot.jsName, tag: 'span', role: 'html', decls: [...placement, {group: 'layout', prop: 'display', value: 'flex'}, {group: 'layout', prop: 'justify-content', value: 'center'}, {group: 'layout', prop: 'align-items', value: 'center'}], children: [{kind: 'expr', key: 'slot', expr: slotName}]};
    }
  }

  // An instance of a component: the component, with props.
  if (node.type === 'INSTANCE') {
    const target = componentRoot(host.doc, node.componentId);
    if (target && !options.root) return instanceElement(host, scope, node, target, {...base, classBase: named('')}, css);
  }

  // A main component standing in a screen (a UI kit's page, a component inside another) is that component used there, in
  // its own look. A variant drawn hovered, pressed or focused is the browser's state of another look, so a set shows each
  // look once.
  if (node.type === 'COMPONENT' && !options.root) {
    const target = componentRoot(host.doc, node.id);
    if (target) {
      if (interactionLook(host.component(target), node.id)) return null;
      const usage: SceneNode = {...node, type: 'INSTANCE', componentId: node.id, componentProperties: {}};
      return instanceElement(host, scope, usage, target, {...base, classBase: classBaseOf(host.doc, usage, '')}, css);
    }
  }

  // Vectors and icon groups: one inline SVG.
  if (isVectorGraphic(host.doc, node.id)) {
    const svg = inlineSvg(host.doc, node.id, {measurer: host.measurer, idPrefix: SVG_ID_PREFIX});
    if (!svg) return null;
    const decls = declarations(node, {...css, paint: 'svg', box: svg.box}).filter(decl => decl.prop !== 'transform');
    if (svg.monochrome) decls.push({group: 'visual', prop: 'color', value: monochromeToken(host, node) ?? suggestedColor(host.css, svg.monochrome, 'text')});
    return {...base, classBase: named('svg'), tag: 'svg', role: 'svg', svg, decls};
  }

  if (node.type === 'TEXT' && node.text) {
    // A text on a path is inline SVG (above) unless a component property sets its text: then it is a plain string.
    if (node.textPath) host.warn(`"${node.name}": text on a path is changed by a component property; in code it is a plain string without the path.`);
    return textElement(host, scope, node, base, css, options.inline);
  }

  if (isImageOnly(node)) {
    const paint = node.fills.find(isVisiblePaint) as Extract<Paint, {type: 'IMAGE'}>;
    const decls = declarations(node, {...css, paint: 'img'});
    decls.push({group: 'visual', prop: 'object-fit', value: paint.scaleMode === 'FIT' ? 'contain' : 'cover'});
    // A picture named only by its kind ("Image", "Rectangle 4") is decoration: an empty alt keeps screen readers quiet.
    const alt = isDefaultLayerName(node.name, node.type) ? '' : node.name;
    return {...base, classBase: named('img'), tag: 'img', role: 'html', decls, attrs: [...base.attrs, {name: 'src', value: assetMark(paint.imageRef), expr: true}, {name: 'alt', value: alt, expr: false}], children: []};
  }

  // A text field: its texts become a label, an <input> and a hint.
  const parts = node.type === 'FRAME' || node.type === 'COMPONENT' ? fieldParts(host.doc, options.root && scope.model ? {...node, name: host.doc.nodes[scope.model.nodeId]?.name ?? node.name} : node) : null;
  // A box inside a field that reads as a field of its own ("Field" in "Input field") stays the outer field's part.
  if (parts && !options.inline && !scope.fields?.has(parts.value)) {
    scope.fields ??= new Map();
    scope.fields.set(parts.value, {role: 'input', group: node.id});
    if (parts.box !== node.id) scope.fields.set(parts.box, {role: 'box', group: node.id});
    if (parts.label) scope.fields.set(parts.label, {role: 'label', group: node.id});
    if (parts.hint) scope.fields.set(parts.hint, {role: 'hint', group: node.id});
  }

  // Containers and shapes. A variant set inside a screen holds its variants (each a usage); its dashed purple frame is the
  // editor's, not the design's.
  const set = node.type === 'COMPONENT_SET' && !options.root;
  const decls = declarations(node, {...css, paint: 'css'}).filter(decl => !set || decl.group !== 'visual');
  let tag = 'div';
  const attrs = [...base.attrs];
  const link = set ? null : urlAction(node);
  if (options.inline) tag = 'span';
  else if (link) {
    tag = 'a';
    attrs.push(...linkAttrs(link.url, link.newTab));
  } else if ((options.root && (scope.model?.button || TOGGLES.has(scope.model?.rootKind ?? ''))) || (!options.root && !set && !scope.model?.button && isButtonLike(node) && node.children?.length && !holdsInteractive(host.doc, node))) {
    // A switch, a checkbox and a radio are buttons too (role and aria-checked come with the component's root).
    tag = 'button';
    attrs.push({name: 'type', value: 'button', expr: false});
  }
  const inline = options.inline || tag === 'a' || tag === 'button';
  const children: El[] = [];
  const seen = new Map<string, number>();
  for (const id of node.children ?? []) {
    const child = host.doc.nodes[id];
    if (!child) continue;
    const childKey = siblingKey(seen, child, key);
    const element = buildElement(host, scope, child, childKey, {root: false, inline});
    if (element) children.push(element);
  }
  if (children.some(child => child.decls.some(decl => decl.prop === 'position' && decl.value === 'absolute')) && !decls.some(decl => decl.prop === 'position')) {
    decls.push({group: 'position', prop: 'position', value: 'relative'});
  }
  const box = scope.fields?.get(node.id)?.role === 'box';
  const classBase = box ? 'field' : set ? `${named(tag)}Variants` : named(tag);
  return {...base, classBase, tag, role: 'html', decls: tag === 'button' || tag === 'a' ? withResets(tag, decls) : decls, attrs, children, ...(box ? {field: 'box' as const} : {})};
}

/** Whether a variant is only an interaction state (hover, pressed, focus) of another look of its component. */
function interactionLook(model: ComponentModel, variantId: NodeId): boolean {
  const state = model.state;
  const variant = model.variants.find(entry => entry.nodeId === variantId);
  const of = state && variant ? state.of.get(variant.options[state.prop]) : undefined;
  return of === 'hover' || of === 'active' || of === 'focus';
}

const TOGGLES: ReadonlySet<string> = new Set(['switch', 'checkbox', 'radio']);

/** Buttons and links lose the browser's look where the design draws its own; what the layer sets wins. */
function withResets(tag: string, decls: Decl[]): Decl[] {
  const resets: Decl[] = tag === 'a'
    ? [{group: 'text', prop: 'color', value: 'inherit', reset: true}, {group: 'text', prop: 'text-decoration', value: 'none', reset: true}]
    : [
      {group: 'layout', prop: 'padding', value: '0', reset: true},
      {group: 'visual', prop: 'background', value: 'none', reset: true},
      {group: 'visual', prop: 'border', value: '0', reset: true},
      {group: 'text', prop: 'font', value: 'inherit', reset: true},
      {group: 'text', prop: 'color', value: 'inherit', reset: true},
      {group: 'visual', prop: 'cursor', value: 'pointer'},
    ];
  const covers = (decl: Decl, prop: string) => decl.prop === prop || (decl.prop.startsWith(prop + '-') && decl.prop !== 'border-radius' && decl.prop !== 'border-image' && !/^border-(top|right|bottom|left)$/.test(decl.prop));
  const needed = resets.filter(reset => !decls.some(decl => covers(decl, reset.prop)));
  // The resets first, so a side the design draws (`border-bottom`) comes after the reset it refines; the pointer last.
  return [...needed.filter(reset => reset.reset), ...decls, ...needed.filter(reset => !reset.reset)];
}

function siblingKey(seen: Map<string, number>, node: SceneNode, parentKey: string): string {
  const name = `${node.type === 'INSTANCE' ? 'i' : node.type === 'TEXT' ? 't' : 'n'}:${slugName(node.name, 'layer')}`;
  const count = (seen.get(name) ?? 0) + 1;
  seen.set(name, count);
  return `${parentKey}/${name}${count > 1 ? '#' + count : ''}`;
}

function propFor(scope: BuildScope, key: string, kind: 'boolean' | 'text' | 'slot'): PropDef | null {
  const prop = scope.model?.props.find(p => p.key === key);
  return prop && prop.kind === kind ? prop : null;
}

/** The expression a prop is read by; a boolean merged into a text or swap prop reads that prop's presence. */
function use(scope: BuildScope, prop: PropDef): string {
  const name = prop.mergedInto ?? prop.jsName;
  scope.used.add(name);
  return name;
}

function monochromeToken(host: BuildHost, node: SceneNode): string | null {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    for (const paint of [...n.fills, ...n.strokes]) {
      const alias = paint.type === 'SOLID' ? paint.boundVariables?.color : undefined;
      const token = alias ? host.css.tokens.byVariable.get(alias.id) : undefined;
      if (token?.name) return `var(--${token.name})`;
    }
    const style = n.fillStyleId ? host.css.tokens.byStyle.get(n.fillStyleId) : undefined;
    if (style?.kind === 'color') return `var(--${style.name})`;
    for (const id of n.children ?? []) if (host.doc.nodes[id]) stack.push(host.doc.nodes[id]);
  }
  return null;
}

// ── Instances ──────────────────────────────────────────────────────────────────────────────────

const FIELD_NAMES: Record<string, string> = {
  fills: 'fill', strokes: 'stroke', strokeWeight: 'stroke weight', effects: 'effects', opacity: 'opacity', visible: 'visibility',
  text: 'text', 'text.characters': 'text', width: 'size', height: 'size', x: 'position', y: 'position', cornerRadius: 'corner radius',
  rectangleCornerRadii: 'corner radius', fillStyleId: 'fill style', textStyleId: 'text style', effectStyleId: 'effect style', componentId: 'nested component',
  name: '', locked: '', overrides: '', reactions: '', exportSettings: '', pluginData: '', annotations: '',
};

function fieldLabel(field: string): string {
  if (field in FIELD_NAMES) return FIELD_NAMES[field];
  if (field.startsWith('text.')) return 'text';
  if (field.startsWith('autoLayout.')) return 'auto layout';
  if (field.startsWith('componentProperties.')) return '';
  if (field.startsWith('boundVariables.')) return 'variables';
  return '';
}

function instanceElement(host: BuildHost, scope: BuildScope, node: SceneNode, target: NodeId, base: Omit<El, 'tag' | 'role' | 'decls'>, css: DeclContext): El {
  const {doc} = host;
  const model = host.component(target);
  const mainId = node.componentId!;
  const main = doc.nodes[mainId];
  // Placement and anything the instance changed on its root go on the usage's class.
  const own = declarations(node, {...css, paint: 'css'});
  const mainDecls = main ? declarations(main, {...css, root: true, paint: 'css'}) : [];
  const decls = own.filter(decl => decl.group === 'position' || decl.group === 'item' || !mainDecls.some(m => m.prop === decl.prop && m.value === decl.value))
    // The component lays itself out; its usage only places it (an inline-flex root stays what the component says).
    .filter(decl => !(decl.prop === 'display' && mainDecls.some(m => m.prop === 'display')));
  for (const m of mainDecls) {
    if (m.group === 'position' || m.group === 'item' || m.prop === 'width' || m.prop === 'height' || m.prop === 'display') continue;
    if (!own.some(decl => decl.prop === m.prop)) decls.push({...m, value: 'unset'});
  }
  // Props: variant values from the variant it points at, the rest from its property values. Texts are always given
  // (content belongs where the component is used), defaults of everything else are left out.
  const props: Attr[] = [];
  const children: Piece[] = [];
  const values = variantValues(doc, mainId);
  const merged = new Map(model.props.filter(prop => prop.mergedInto).map(prop => [prop.mergedInto!, prop] as const));
  for (const prop of model.props) {
    const raw = prop.kind === 'variant' || prop.kind === 'variantBool' ? values[prop.key] : node.componentProperties?.[prop.key];
    if (prop.kind === 'variant') {
      const option = prop.options.find(o => o.value === raw);
      if (!option) continue;
      const isState = !!model.state && model.variantProps[model.state.prop] === prop;
      const state = isState ? model.state!.of.get(option.id) : undefined;
      // An instance drawn hovered or pressed is the component itself; disabled is the native prop.
      if (state === 'disabled') props.push({name: 'disabled', value: '', expr: true});
      else if (state && state !== 'rest') continue;
      else if (isState) {
        const api = stateApi(model).prop;
        if (option.id !== model.state!.rest && api) props.push(api.kind === 'variantBool' ? {name: api.jsName, value: '', expr: true} : {name: api.jsName, value: option.id, expr: false});
      } else if (option.id !== prop.defaultRaw) props.push(literalAttr(prop, option.id));
    } else if (prop.kind === 'variantBool') {
      if (raw === undefined) continue;
      const on = String(raw).trim().toLowerCase() === prop.options[0].value.trim().toLowerCase();
      if (on !== prop.defaultRaw) props.push(on ? {name: prop.jsName, value: '', expr: true} : {name: prop.jsName, value: 'false', expr: true});
    } else if (prop.kind === 'boolean') {
      if (prop.mergedInto || typeof raw !== 'boolean' || raw === prop.defaultRaw) continue;
      props.push(raw ? {name: prop.jsName, value: '', expr: true} : {name: prop.jsName, value: 'false', expr: true});
    } else if (prop.kind === 'text') {
      // A generated label reads the instance's own copy of the text, and so does a variant that writes its own text there.
      const layers = prop.label ?? prop.standIns;
      const own = layers ? copyOf(doc, node, layers)?.text?.characters : undefined;
      const text = own ?? (typeof raw === 'string' ? raw : String(prop.defaultRaw ?? ''));
      const toggle = merged.get(prop.jsName);
      const shown = toggle ? (typeof node.componentProperties?.[toggle.key] === 'boolean' ? node.componentProperties[toggle.key] : toggle.defaultRaw) === true : true;
      if (!shown) continue;
      if (prop.native === 'children') children.push(...textPieces(text, {n: 0}));
      // The field writes its own placeholder: a usage gives one only when it is another.
      else if (!(prop.native === 'placeholder' && text === prop.defaultRaw)) props.push({name: prop.jsName, value: text, expr: false});
    } else if (prop.kind === 'slot') {
      const toggle = merged.get(prop.jsName);
      const shown = toggle ? (typeof node.componentProperties?.[toggle.key] === 'boolean' ? node.componentProperties[toggle.key] : toggle.defaultRaw) === true : true;
      const swapped = typeof raw === 'string' ? componentRoot(doc, raw) : null;
      if (!shown) {
        // Hidden: an optional slot with a default is turned off by null; one without a default is just left out.
        if (prop.defaultComponent) props.push({name: prop.jsName, value: 'null', expr: true});
        continue;
      }
      const picked = swapped ? raw as string : prop.defaultComponent;
      if (!picked) continue;
      if (picked === prop.defaultComponent && !(toggle && toggle.defaultRaw !== true)) continue;
      const pickedRoot = componentRoot(doc, picked);
      if (!pickedRoot) continue;
      const swapModel = host.component(pickedRoot);
      props.push({name: prop.jsName, value: `<${swapModel.name}${variantPropsOf(host, swapModel, picked)} />`, expr: true});
    }
  }
  const note = overrideNote(doc, node, new Set(model.props.flatMap(prop => [...(prop.label ?? []), ...(prop.standIns ?? [])])));
  if (note) host.warn(note);
  return {...base, tag: model.name, role: 'component', decls, props, children};
}

/** A variant option as a JSX attribute: `size="small"`, `size={40}`, `checked`, `checked={false}`, `checked="mixed"`. */
function literalAttr(prop: PropDef, id: string): Attr {
  const literal = optionLiteral(prop, id);
  if (literal === 'true') return {name: prop.jsName, value: '', expr: true};
  return literal.startsWith("'") ? {name: prop.jsName, value: id, expr: false} : {name: prop.jsName, value: literal, expr: true};
}

/** The variant props that pick `componentId` inside its set (for a swapped-in instance). */
function variantPropsOf(host: BuildHost, model: ComponentModel, componentId: NodeId): string {
  const values = variantValues(host.doc, componentId);
  let out = '';
  for (const prop of model.variantProps) {
    const raw = values[prop.key];
    if (prop.kind === 'variant') {
      const option = prop.options.find(o => o.value === raw);
      if (model.state && model.variantProps[model.state.prop] === prop) continue;
      if (option && option.id !== prop.defaultRaw) {
        const attr = literalAttr(prop, option.id);
        out += !attr.expr ? ` ${attr.name}="${attr.value}"` : attr.value === '' ? ` ${attr.name}` : ` ${attr.name}={${attr.value}}`;
      }
    } else if (raw !== undefined) {
      const on = raw.trim().toLowerCase() === prop.options[0].value.trim().toLowerCase();
      if (on !== prop.defaultRaw) out += on ? ` ${prop.jsName}` : ` ${prop.jsName}={false}`;
    }
  }
  return out;
}

/** The instance's copy of one of `mains` (layers of its component), or the layer itself in a main component used in place. */
function copyOf(doc: DesignDocument, instance: SceneNode, mains: ReadonlySet<NodeId>): SceneNode | undefined {
  const stack = [...(instance.children ?? [])];
  while (stack.length) {
    const copy = doc.nodes[stack.pop()!];
    if (!copy) continue;
    if ((copy.mainId && mains.has(copy.mainId)) || mains.has(copy.id)) return copy;
    if (copy.children && copy.type !== 'INSTANCE') stack.push(...copy.children);
  }
  return undefined;
}

/** What a copy inside the instance changed that no prop carries: said once in the result's notes, never in the code. */
function overrideNote(doc: DesignDocument, instance: SceneNode, labels: ReadonlySet<NodeId> = new Set()): string | null {
  const notes: string[] = [];
  const stack = [...(instance.children ?? [])];
  while (stack.length && notes.length < 8) {
    const copy = doc.nodes[stack.shift()!];
    if (!copy) continue;
    if (copy.children && copy.type !== 'INSTANCE') stack.push(...copy.children);
    if (!copy.overrides?.length) continue;
    const mirror = copy.mainId ? doc.nodes[copy.mainId] : undefined;
    const refs = mirror?.componentPropertyReferences ?? copy.componentPropertyReferences;
    const carried = !!copy.mainId && labels.has(copy.mainId);
    const labels2 = new Set<string>();
    for (const field of copy.overrides) {
      if ((refs?.characters || carried) && (field === 'text.characters' || field === 'text.runs' || field === 'text')) continue;
      if (refs?.visible && field === 'visible') continue;
      if (refs?.mainComponent && field === 'componentId') continue;
      const label = fieldLabel(field);
      if (label) labels2.add(label);
    }
    if (!labels2.size) continue;
    const detail = [...labels2].map(label => (label === 'text' && copy.text ? `text "${clip(copy.text.characters)}"` : label));
    notes.push(`"${copy.name}": ${detail.join(', ')}`);
  }
  return notes.length ? `Instance "${clip(instance.name)}" was changed in the design in a way the component properties do not carry: ${notes.join('; ')}. The code uses the component's default look.` : null;
}

const clip = (text: string) => (text.length > 40 ? text.slice(0, 39) + '…' : text).replace(/\s+/g, ' ');

// ── Text ───────────────────────────────────────────────────────────────────────────────────────

type Segment = {start: number; end: number; style: TextStyle; fills: Paint[]; styleId: string | undefined; link: Hyperlink | null};

function segmentsOf(node: SceneNode): Segment[] {
  const text = node.text!;
  const length = text.characters.length;
  const cuts = new Set<number>([0, length]);
  for (const run of text.runs) {
    cuts.add(Math.max(0, Math.min(length, run.start)));
    cuts.add(Math.max(0, Math.min(length, run.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i], end = points[i + 1];
    if (end <= start) continue;
    const run = text.runs.find(r => r.start <= start && r.end >= end);
    const style = run ? {...text.style, ...run.style} : text.style;
    out.push({start, end, style, fills: run?.fills ?? node.fills, styleId: run?.textStyleId ?? node.textStyleId, link: style.hyperlink ?? null});
  }
  return out;
}

/** The tag of a text: a heading from the outline, a paragraph when it wraps, else an inline label. */
function textTag(host: BuildHost, node: SceneNode, inline: boolean): string {
  if (inline) return 'span';
  const level = host.headings.get(node.id);
  if (level) return `h${level}`;
  const text = node.text!;
  return text.characters.includes('\n') || text.textAutoResize !== 'WIDTH_AND_HEIGHT' ? 'p' : 'span';
}

const INPUT_RESETS: Decl[] = [
  {group: 'visual', prop: 'border', value: '0', reset: true},
  {group: 'layout', prop: 'padding', value: '0', reset: true},
  {group: 'visual', prop: 'background', value: 'none', reset: true},
  {group: 'visual', prop: 'outline', value: 'none'},
  {group: 'size', prop: 'min-width', value: '0'},
];

function textElement(host: BuildHost, scope: BuildScope, node: SceneNode, base: Omit<El, 'tag' | 'role' | 'decls'>, css: DeclContext, inline: boolean): El {
  const text = node.text!;
  const part = scope.fields?.get(node.id);
  const field = part?.role;
  const fieldGroup = part?.group;
  const hasLists = !field && (text.listTypes ?? []).some(type => type && type !== 'NONE');
  const tag = field === 'input' ? 'input' : field === 'label' ? 'label' : field === 'hint' ? 'p' : hasLists ? 'div' : textTag(host, node, inline);
  const classBase = base.classBase || (field === 'input' ? 'input' : field === 'label' ? 'label' : field === 'hint' ? 'hint' : classBaseOf(host.doc, node, tag));
  // Paragraphs and headings come with browser margins; the design has none.
  const margin: Decl[] = tag === 'p' || /^h[1-6]$/.test(tag) ? [{group: 'layout', prop: 'margin', value: '0', reset: true}] : [];
  const own = declarations(node, {...css, paint: 'css'});
  if (field === 'input') {
    // The input is the text: it takes the text's type and colour, without the browser's box, and its single line
    // never wraps (a fixed width becomes the flex share it had).
    const decls = [...own.filter(decl => decl.prop !== 'white-space' && decl.prop !== 'height' && !(decl.prop === 'display' && decl.group === 'text') && decl.prop !== 'flex-direction' && decl.prop !== 'justify-content'), ...INPUT_RESETS.filter(reset => !own.some(decl => decl.prop === reset.prop))];
    return {...base, classBase, tag, role: 'html', decls, field, fieldGroup, text: text.characters, children: []};
  }
  const decls: Decl[] = [...margin, ...own];
  const bound = node.componentPropertyReferences?.characters ? propFor(scope, node.componentPropertyReferences.characters, 'text') : scope.model?.props.find(prop => prop.label?.has(node.id) || prop.standIns?.has(node.id)) ?? null;
  if (bound) {
    const name = use(scope, bound);
    // An optional text (its show/hide boolean merged into it) renders only when given.
    const condition = bound.optional && !base.condition ? name : base.condition;
    // Keyed as a plain text's first piece, so a variant that writes its own text there merges into one expression.
    return {...base, condition, classBase, tag, role: 'html', decls, field, fieldGroup, text: text.characters, children: [{kind: 'expr', key: 't0', expr: name}]};
  }

  const whole = wholeTextStyle(node);
  const segments = segmentsOf(node);
  // Per segment: what it changes against the whole text's style.
  const styled = segments.map(segment => {
    const diff = [
      ...typographyDecls(css, node, segment.style, segment.styleId, whole.style, whole.styleId),
      ...(JSON.stringify(segment.fills) === JSON.stringify(whole.fills) ? [] : textPaintDecls(css, node, segment.fills, segment.styleId)),
    ];
    const url = segment.link?.type === 'URL' && SAFE_URL.test(segment.link.url) ? segment.link.url : null;
    // A link keeps the text's colour, not the browser's blue.
    if (url && !diff.some(decl => decl.prop === 'color')) diff.push({group: 'text', prop: 'color', value: 'inherit'});
    return {...segment, diff, url};
  });
  const pieceKey = {n: 0};
  const inlineContent = (start: number, end: number, prefix: string): (El | Piece)[] => {
    const out: (El | Piece)[] = [];
    for (const segment of styled) {
      const from = Math.max(start, segment.start), to = Math.min(end, segment.end);
      if (to <= from) continue;
      const pieces = textPieces(text.characters.slice(from, to), pieceKey);
      if (!segment.diff.length && !segment.url) {
        out.push(...pieces);
        continue;
      }
      out.push({
        kind: 'el', key: `${prefix}/s${pieceKey.n++}`, nodeId: node.id, name: node.name, tag: segment.url ? 'a' : 'span', role: 'html', classBase: segment.url ? `${classBase}Link` : `${classBase}Span`, decls: segment.diff,
        attrs: segment.url ? linkAttrs(segment.url, true) : [], props: [], children: pieces, condition: null,
      });
    }
    return out;
  };

  if (!hasLists) return {...base, classBase, tag, role: 'html', decls, field, fieldGroup, text: text.characters, children: inlineContent(0, text.characters.length, base.key)};

  // Paragraphs: list paragraphs become ul/ol items, the others stay lines of text.
  const children: (El | Piece)[] = [];
  const paragraphs: {start: number; end: number; type: 'NONE' | 'ORDERED' | 'UNORDERED'}[] = [];
  let at = 0;
  text.characters.split('\n').forEach((line, i) => {
    paragraphs.push({start: at, end: at + line.length, type: text.listTypes?.[i] ?? 'NONE'});
    at += line.length + 1;
  });
  for (let i = 0; i < paragraphs.length;) {
    const paragraph = paragraphs[i];
    if (paragraph.type === 'NONE') {
      if (children.length && children[children.length - 1].kind !== 'el') children.push({kind: 'br', key: `b${pieceKey.n++}`});
      children.push(...inlineContent(paragraph.start, paragraph.end, base.key));
      i++;
      continue;
    }
    const items: El[] = [];
    let j = i;
    for (; j < paragraphs.length && paragraphs[j].type === paragraph.type; j++) {
      items.push({kind: 'el', key: `${base.key}/li${j}`, nodeId: node.id, name: node.name, tag: 'li', role: 'html', classBase: `${classBase}Item`, decls: [], attrs: [], props: [], children: inlineContent(paragraphs[j].start, paragraphs[j].end, `${base.key}/li${j}`), condition: null});
    }
    children.push({kind: 'el', key: `${base.key}/list${i}`, nodeId: node.id, name: node.name, tag: LIST_TAG[paragraph.type], role: 'html', classBase: `${classBase}List`, attrs: [], props: [], children: items, condition: null,
      decls: [{group: 'layout', prop: 'margin', value: '0', reset: true}, {group: 'layout', prop: 'padding-left', value: '1.5em'}]});
    i = j;
  }
  return {...base, classBase, tag, role: 'html', decls, children};
}

/** Text with line breaks as <br />. */
export function textPieces(text: string, counter: {n: number}): Piece[] {
  const out: Piece[] = [];
  text.split('\n').forEach((line, i) => {
    if (i) out.push({kind: 'br', key: `b${counter.n++}`});
    if (line) out.push({kind: 'text', key: `t${counter.n++}`, text: line});
  });
  return out;
}
