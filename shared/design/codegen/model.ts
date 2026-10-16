import type {ComponentPropertyDefinition, DesignDocument, NodeId, SceneNode} from '../types';
import {defaultVariant, parseVariantName, propertyDefinitionsOf, propertyName, variantValues} from '../components';
import {NameRegistry, componentName, memberName, nameWords, pascalCase, valueName} from './names';
import {isVisiblePaint} from './values';

// What a component looks like as a React component: its name, its typed props (from component
// properties) and, for a variant set, the space of variants the per-variant styles are keyed on.
//
// A production component never takes `state="hover"`: a variant property whose options are interaction states
// (hover, pressed, focus, disabled beside a default) is the browser's business. Its interactive options become
// CSS states (:hover, :active, :focus-visible, :disabled) and `disabled` a native prop; the options that are looks
// of their own (an error, a loading look) stay props. The root's element follows what the component is: a
// button, a switch or checkbox with `aria-checked`, a text field around a real <input>, or a plain element.

export type PropKind = 'variant' | 'variantBool' | 'boolean' | 'text' | 'slot';

export type PropOption = {value: string; id: string};

export type PropDef = {
  /** Key in componentPropertyDefinitions (variant properties: the property name). */
  key: string;
  jsName: string;
  kind: PropKind;
  /** The property name as the designer wrote it. */
  original: string;
  /** variant: the options with their safe ids; variantBool: [true option, false option]. */
  options: PropOption[];
  /** The default as written in the props' destructuring (a JS expression), null when there is none. */
  defaultRaw: string | boolean | null;
  /** INSTANCE_SWAP: the default component. */
  defaultComponent?: NodeId;
  /** variant: every option is a number ("24", "32"), so the prop is a union of number literals. */
  numeric?: boolean;
  /** BOOLEAN: it only shows or hides a layer that a text or swap prop fills, so that prop's presence decides. */
  mergedInto?: string;
  /** TEXT or slot: a merged boolean makes it optional, shown only when given. */
  optional?: boolean;
  /** TEXT: the text is the component's content (`children`) or the field's `placeholder`, a native prop. */
  native?: 'children' | 'placeholder';
  /** A checkbox's `checked` with a third, mixed look: `boolean | 'mixed'`, options 'true', 'false', 'mixed'. */
  tristate?: boolean;
  /** TEXT made by the generator, not the designer: the one label of a button that has no text property. The layers it fills,
   *  one per variant; an instance passes its own copy's text. */
  label?: ReadonlySet<NodeId>;
  /** TEXT: the layers of variants that write their own text where the others show the prop ("Error" with its message in
   *  "Hint"). The component shows the prop there too; a usage of such a variant passes that text. */
  standIns?: ReadonlySet<NodeId>;
};

export type VariantEntry = {nodeId: NodeId; options: string[]};

/** A state the browser keeps: the variant options that draw it become CSS (:hover, :active, :focus-visible, :disabled). */
export type InteractiveState = 'hover' | 'active' | 'focus' | 'disabled';

export type StateDimension = {
  /** Index in `variantProps`. */
  prop: number;
  /** Option id → the CSS state it draws, or 'rest' for a look of its own (the default, an error look). */
  of: Map<string, InteractiveState | 'rest'>;
  /** The option every interactive look is compared with ("Default"). */
  rest: string;
  states: Set<InteractiveState>;
};

/** What the component's root is in HTML. */
export type RootKind = 'button' | 'switch' | 'checkbox' | 'radio' | 'field' | 'plain';

export type ComponentModel = {
  /** The COMPONENT, or the COMPONENT_SET of variants. */
  nodeId: NodeId;
  name: string;
  props: PropDef[];
  /** Variant props, in the order of `variants[i].options`. */
  variantProps: PropDef[];
  /** One entry for a single component. */
  variants: VariantEntry[];
  defaultIndex: number;
  /** The root is a <button> (a layer named "Button", or one with a click interaction). */
  button: boolean;
  rootKind: RootKind;
  /** The variant property of interaction states, if there is one. */
  state: StateDimension | null;
  /** Index in `variantProps` of the on/off property a switch, checkbox or radio reads as `checked`. */
  checked: number | null;
};

const BOOL_PAIRS: [string, string][] = [['true', 'false'], ['yes', 'no'], ['да', 'нет'], ['on', 'off'], ['вкл', 'выкл'], ['вкл.', 'выкл.']];
const normal = (value: string) => value.trim().toLowerCase().replace(/ё/g, 'е');
/** Option ids (English, from valueName) that read as on and off. */
const ID_PAIRS: [string, string][] = [['on', 'off'], ['checked', 'unchecked'], ['selected', 'unselected'], ['active', 'inactive'], ['yes', 'no'], ['true', 'false']];
/** The third look of a checkbox that is neither on nor off. */
const MIXED_IDS = new Set(['mixed', 'indeterminate', 'partial', 'partially', 'some']);

/** The on/off pair (and a mixed third) among a variant prop's options, if it reads as one. */
function onOffOf(prop: PropDef): {yes: PropOption; no: PropOption; mixed: PropOption | null} | null {
  if (prop.kind !== 'variant' || prop.options.length < 2 || prop.options.length > 3) return null;
  for (const [yes, no] of ID_PAIRS) {
    const a = prop.options.find(o => o.id === yes), b = prop.options.find(o => o.id === no);
    if (!a || !b) continue;
    const rest = prop.options.filter(o => o !== a && o !== b);
    if (rest.length === 0) return {yes: a, no: b, mixed: null};
    if (rest.length === 1 && MIXED_IDS.has(rest[0].id)) return {yes: a, no: b, mixed: rest[0]};
  }
  return null;
}

/** [true value, false value] when a variant property is really a switch. */
function booleanPair(options: readonly string[]): [string, string] | null {
  if (options.length !== 2) return null;
  for (const [yes, no] of BOOL_PAIRS) {
    const a = options.find(option => normal(option) === yes), b = options.find(option => normal(option) === no);
    if (a !== undefined && b !== undefined) return [a, b];
  }
  return null;
}

const PROP_PREFIX = /^(is|has|show|with|can|should|without)[A-Z0-9]/;
const BUTTON_NAME = /(^|[^\p{L}])(кнопк|button|btn)/iu;
const SWITCH_NAME = /(switch|toggle|переключател|свитч|тумблер)/iu;
const CHECKBOX_NAME = /(checkbox|check box|чекбокс|флажок|чек-бокс)/iu;
const RADIO_NAME = /(radio|радио)/iu;
const FIELD_NAME = /(^|[^\p{L}])(input|text ?field|textarea|search|field|поле|инпут|поиск|ввод)/iu;

export function isButtonLike(node: SceneNode): boolean {
  if (BUTTON_NAME.test(node.name)) return true;
  return node.reactions.some(reaction => PRESS_TRIGGERS.has(reaction.trigger.type) && reaction.actions.some(action => action.type === 'NODE' || action.type === 'BACK' || action.type === 'CLOSE'));
}

/** Triggers a press of a button sets off: a click, holding it, the mouse button going down or up. */
export const PRESS_TRIGGERS: ReadonlySet<string> = new Set(['ON_CLICK', 'ON_PRESS', 'MOUSE_DOWN', 'MOUSE_UP']);

/** Whether a layer holds something interactive (an instance, a main component, a button, a link): a button never holds
 *  one (invalid HTML), so a frame called "Button" around them stays a frame. */
export function holdsInteractive(doc: DesignDocument, node: SceneNode): boolean {
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const child = doc.nodes[stack.pop()!];
    if (!child) continue;
    if (child.type === 'INSTANCE' || child.type === 'COMPONENT' || isButtonLike(child) || child.reactions.some(reaction => reaction.actions.some(action => action.type === 'URL'))) return true;
    if (child.children) stack.push(...child.children);
  }
  return false;
}

// ── Interaction states ─────────────────────────────────────────────────────────────────────────

const REST_IDS = new Set(['default', 'rest', 'normal', 'enabled', 'idle', 'regular', 'base', 'static', 'initial', 'resting']);
const STATE_IDS: Record<string, InteractiveState> = {
  hover: 'hover', hovered: 'hover', hovering: 'hover', mouseOver: 'hover',
  pressed: 'active', press: 'active', pressing: 'active', clicked: 'active', tap: 'active', tapped: 'active',
  focus: 'focus', focused: 'focus', focusVisible: 'focus', focusRing: 'focus',
  disabled: 'disabled',
};

/** The interaction-state property of a component, if one of its variant props is one: a default option and at least one
 *  of hover, pressed, focus or disabled. "Active" is pressed only on a button that also has hover (on a tab it is the chosen one). */
function stateDimension(props: readonly PropDef[], button: boolean): StateDimension | null {
  for (let p = 0; p < props.length; p++) {
    const prop = props[p];
    if (prop.kind !== 'variant') continue;
    const ids = prop.options.map(option => option.id);
    const rest = ids.find(id => REST_IDS.has(id));
    if (!rest) continue;
    const of = new Map<string, InteractiveState | 'rest'>();
    const states = new Set<InteractiveState>();
    const pressedIsActive = button && ids.includes('hover') && !ids.some(id => STATE_IDS[id] === 'active');
    for (const id of ids) {
      const state = STATE_IDS[id] ?? (id === 'active' && pressedIsActive ? 'active' : undefined);
      if (state && !(state === 'active' && states.has('active'))) {
        of.set(id, state);
        states.add(state);
      } else of.set(id, 'rest');
    }
    if (states.size) return {prop: p, of, rest, states};
  }
  return null;
}

// ── The root's element ─────────────────────────────────────────────────────────────────────────

/** The parts of a text field: the framed box and the text inside it (the value or placeholder), and the label
 *  and hint around the box. Null when `node` holds no text inside a box with a fill or a stroke. */
export function fieldParts(doc: DesignDocument, node: SceneNode): {box: NodeId; value: NodeId; label: NodeId | null; hint: NodeId | null} | null {
  if (!FIELD_NAME.test(node.name)) return null;
  const order: SceneNode[] = [];
  const walk = (id: NodeId, depth: number) => {
    const child = doc.nodes[id];
    if (!child || child.visible === false || depth > 6) return;
    order.push(child);
    if (child.children && child.type !== 'INSTANCE' && child.type !== 'BOOLEAN_OPERATION') for (const next of child.children) walk(next, depth + 1);
  };
  walk(node.id, 0);
  const framed = (n: SceneNode) => (n.fills.some(isVisiblePaint) || n.strokes.some(isVisiblePaint) || n.effects.some(e => e.visible !== false && e.type !== 'LAYER_BLUR'));
  const isBox = (n: SceneNode) => n.id !== node.id && (n.type === 'FRAME' || n.type === 'INSTANCE') && framed(n);
  // The box: the first framed frame with a text of its own; the root itself is the box of a field without a label.
  const boxes = order.filter(n => (isBox(n) || n.id === node.id) && n.type !== 'INSTANCE');
  for (const box of [...boxes.filter(n => n.id !== node.id), ...boxes.filter(n => n.id === node.id && framed(n))]) {
    const texts = (box.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.type === 'TEXT' && !!child.text && child.visible !== false);
    if (!texts.length) continue;
    // The widest text is the value (a "+7" prefix beside it stays a text).
    const value = texts.reduce((best, text) => (text.width > best.width ? text : best));
    const boxAt = order.indexOf(box);
    const inside = new Set<NodeId>();
    const mark = (id: NodeId) => {
      inside.add(id);
      for (const child of doc.nodes[id]?.children ?? []) mark(child);
    };
    mark(box.id);
    const outside = order.filter(n => n.type === 'TEXT' && n.text && !inside.has(n.id));
    const label = box.id === node.id ? null : outside.filter(n => order.indexOf(n) < boxAt).pop() ?? null;
    const hint = box.id === node.id ? null : outside.find(n => order.indexOf(n) > boxAt) ?? null;
    return {box: box.id, value: value.id, label: label?.id ?? null, hint: hint?.id ?? null};
  }
  return null;
}

function rootKindOf(doc: DesignDocument, root: SceneNode, named: SceneNode, props: readonly PropDef[], button: boolean): {kind: RootKind; checked: number | null} {
  const onOff = props.findIndex(prop => prop.kind === 'variantBool' || onOffOf(prop));
  if (onOff >= 0) {
    const mixed = props[onOff].kind === 'variant' && !!onOffOf(props[onOff])!.mixed;
    if (SWITCH_NAME.test(named.name) && !mixed) return {kind: 'switch', checked: onOff};
    if (CHECKBOX_NAME.test(named.name)) return {kind: 'checkbox', checked: onOff};
    if (RADIO_NAME.test(named.name) && !mixed) return {kind: 'radio', checked: onOff};
  }
  if (fieldParts(doc, {...root, name: named.name})) return {kind: 'field', checked: null};
  return {kind: button ? 'button' : 'plain', checked: null};
}

// ── The model ──────────────────────────────────────────────────────────────────────────────────

/** The React shape of a COMPONENT or COMPONENT_SET. `names` is the project-wide registry of top-level names. */
export function componentModel(doc: DesignDocument, nodeId: NodeId, names: NameRegistry): ComponentModel {
  const node = doc.nodes[nodeId];
  const set = node.type === 'COMPONENT_SET' ? node : null;
  const variants: VariantEntry[] = [];
  const name = names.claim(componentName(set ? set.name : node.name.replace(/=/g, ' '), 'Component'));
  const propNames = new NameRegistry(['className', 'style', 'children', 'key', 'ref', 'onClick', 'placeholder', 'disabled', 'checked'], {caseSensitive: true});

  const definitions: Record<string, ComponentPropertyDefinition> = {...propertyDefinitionsOf(doc, nodeId)};
  const variantNodes = set ? (set.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => child?.type === 'COMPONENT') : [node];
  if (set) {
    // Properties a variant defines for itself join the set's (all variants share them in the UI).
    for (const variant of variantNodes) {
      for (const [key, def] of Object.entries(variant.componentPropertyDefinitions ?? {})) if (!(key in definitions)) definitions[key] = def;
    }
  }

  const props: PropDef[] = [];
  const variantProps: PropDef[] = [];
  const entries = Object.entries(definitions);
  const order: ComponentPropertyDefinition['type'][] = ['VARIANT', 'TEXT', 'BOOLEAN', 'INSTANCE_SWAP'];
  // A variant property called "Type" would hide a button's or an input's own `type`: it is the component's variant.
  const variantName = (original: string) => {
    const base = memberName(original, 'variant');
    return base === 'type' && !entries.some(([key]) => memberName(propertyName(key)) === 'variant') ? 'variant' : base;
  };
  for (const type of order) {
    for (const [key, def] of entries) {
      if (def.type !== type) continue;
      const original = propertyName(key);
      if (type === 'VARIANT') {
        const values = def.variantOptions?.length ? def.variantOptions : [...new Set(variantNodes.map(v => parseVariantName(v.name)?.[key]).filter((v): v is string => !!v))];
        const pair = booleanPair(values);
        if (pair) {
          const prop: PropDef = {key, jsName: propNames.claim(variantName(original)), kind: 'variantBool', original, options: [{value: pair[0], id: 'true'}, {value: pair[1], id: 'false'}], defaultRaw: normal(String(def.defaultValue)) === normal(pair[0])};
          props.push(prop);
          variantProps.push(prop);
          continue;
        }
        const ids = new NameRegistry([], {caseSensitive: true});
        const numeric = values.length > 0 && values.every(value => /^-?\d+(\.\d+)?$/.test(value.trim()));
        const options = values.map(value => ({value, id: numeric ? String(Number(value.trim())) : ids.claim(valueName(value, 'option'))}));
        const fallback = options.find(option => option.value === def.defaultValue) ?? options[0];
        const prop: PropDef = {key, jsName: propNames.claim(variantName(original)), kind: 'variant', original, options, defaultRaw: fallback ? fallback.id : null, ...(numeric ? {numeric} : {})};
        props.push(prop);
        variantProps.push(prop);
      } else if (type === 'TEXT') {
        props.push({key, jsName: propNames.claim(memberName(original, 'text')), kind: 'text', original, options: [], defaultRaw: String(def.defaultValue)});
      } else if (type === 'BOOLEAN') {
        let base = memberName(original, 'visible');
        if (!PROP_PREFIX.test(base)) base = 'show' + pascalCase(nameWords(original).length ? nameWords(original) : ['visible']);
        props.push({key, jsName: propNames.claim(base), kind: 'boolean', original, options: [], defaultRaw: def.defaultValue === true});
      } else {
        const target = typeof def.defaultValue === 'string' ? def.defaultValue : undefined;
        props.push({key, jsName: propNames.claim(memberName(original, 'slot')), kind: 'slot', original, options: [], defaultRaw: null, defaultComponent: target && doc.nodes[target] ? target : undefined});
      }
    }
  }

  for (const variant of variantNodes) {
    const values = set ? variantValues(doc, variant.id) : {};
    variants.push({
      nodeId: variant.id,
      options: variantProps.map(prop => {
        const value = values[prop.key];
        if (prop.kind === 'variantBool') return normal(value ?? '') === normal(prop.options[0].value) ? 'true' : 'false';
        return prop.options.find(option => option.value === value)?.id ?? prop.options[0]?.id ?? '';
      }),
    });
  }
  const fallbackId = set ? defaultVariant(doc, set.id) : node.id;
  const defaultIndex = Math.max(0, variants.findIndex(entry => entry.nodeId === fallbackId));
  // The defaults follow the default variant, so a bare <Button /> looks like the main component.
  variantProps.forEach((prop, i) => {
    const id = variants[defaultIndex]?.options[i];
    if (id !== undefined) prop.defaultRaw = prop.kind === 'variantBool' ? id === 'true' : id;
  });
  const root = doc.nodes[variants[defaultIndex]?.nodeId ?? nodeId] ?? node;
  const button = isButtonLike(set ?? root);
  const {kind: rootKind, checked} = rootKindOf(doc, root, set ?? root, variantProps, button);
  const state = stateDimension(variantProps, button || rootKind !== 'plain');
  if (checked !== null) {
    // On or off, whatever the options are called: `checked`, a boolean (or `'mixed'` for a checkbox's third look).
    const prop = variantProps[checked];
    const pair = onOffOf(prop);
    if (pair) {
      const idOf = (id: string) => (id === pair.yes.id ? 'true' : id === pair.no.id ? 'false' : 'mixed');
      for (const variant of variants) variant.options[checked] = idOf(variant.options[checked]);
      if (pair.mixed) Object.assign(prop, {options: [{value: pair.no.value, id: 'false'}, {value: pair.yes.value, id: 'true'}, {value: pair.mixed.value, id: 'mixed'}], defaultRaw: idOf(String(prop.defaultRaw)), tristate: true});
      else Object.assign(prop, {kind: 'variantBool', options: [{value: pair.yes.value, id: 'true'}, {value: pair.no.value, id: 'false'}], defaultRaw: prop.defaultRaw === pair.yes.id});
    }
    prop.jsName = 'checked';
  }
  refineContentProps(doc, props, variantNodes, rootKind, (set ?? root).name);
  return {nodeId, name, props, variantProps, variants, defaultIndex, button, rootKind, state, checked};
}

/** Text and boolean props as a developer writes them: the one label of a button or tag is its `children`, the text of a
 *  field's box its `placeholder`, and a boolean that only shows the layer a text or swap prop fills merges into that
 *  prop (`hint?: string`, `icon?: ReactNode`: shown when given). */
function refineContentProps(doc: DesignDocument, props: PropDef[], variantNodes: readonly SceneNode[], rootKind: RootKind, name: string) {
  const layersOf = (field: 'visible' | 'characters' | 'mainComponent', key: string) => {
    const out: SceneNode[] = [];
    for (const variant of variantNodes) {
      const stack = [variant.id];
      while (stack.length) {
        const n = doc.nodes[stack.pop()!];
        if (!n) continue;
        if (n.componentPropertyReferences?.[field] === key) out.push(n);
        if (n.children && n.type !== 'INSTANCE') stack.push(...n.children);
      }
    }
    return out;
  };
  for (const prop of props) {
    if (prop.kind !== 'boolean') continue;
    const shown = layersOf('visible', prop.key);
    if (!shown.length) continue;
    // The layer it shows is filled by one text prop (a variant may write its own text there, an error message) or one swap prop.
    const into = props.find(other => (other.kind === 'text' && shown.some(n => n.componentPropertyReferences?.characters === other.key) && shown.every(n => n.componentPropertyReferences?.characters === other.key || (n.type === 'TEXT' && !n.componentPropertyReferences?.characters)))
      || (other.kind === 'slot' && shown.every(n => n.componentPropertyReferences?.mainComponent === other.key)));
    if (!into || into.optional) continue;
    prop.mergedInto = into.jsName;
    into.optional = true;
    // Hidden by default: the design's default content is only an example, and the prop is given where it shows.
    if (prop.defaultRaw !== true) {
      into.defaultRaw = into.kind === 'text' ? null : into.defaultRaw;
      if (into.kind === 'slot') into.defaultComponent = undefined;
    }
  }
  // A variant that writes its own text where the others bind a text prop: the same layer (by name, the only one so named in
  // that variant) shows the prop too, so content always comes from where the component is used.
  for (const prop of props) {
    if (prop.kind !== 'text') continue;
    const bound = new Set<string>();
    const unbound: SceneNode[][] = [];
    for (const variant of variantNodes) {
      const texts = textsOf(doc, variant);
      const mine = texts.filter(n => n.componentPropertyReferences?.characters === prop.key);
      for (const n of mine) bound.add(n.name);
      unbound.push(mine.length ? [] : texts.filter(n => !n.componentPropertyReferences?.characters));
    }
    const standIns = new Set<NodeId>();
    for (const texts of unbound) {
      const named = texts.filter(n => bound.has(n.name));
      if (named.length === 1) standIns.add(named[0].id);
    }
    if (standIns.size) prop.standIns = standIns;
  }
  // A button with one text and no text property still takes its label: content belongs where the button is used.
  if ((rootKind === 'button' || rootKind === 'switch' || rootKind === 'checkbox' || rootKind === 'radio') && !props.some(prop => prop.kind === 'text')) {
    const labels = variantNodes.map(variant => soleText(doc, variant));
    if (labels.every(Boolean)) {
      const sample = labels[0]!;
      props.push({key: '\u0000label', jsName: rootKind === 'button' ? 'children' : 'label', kind: 'text', original: sample.name, options: [], defaultRaw: sample.text!.characters,
        label: new Set(labels.map(label => label!.id)), ...(rootKind === 'button' ? {native: 'children' as const} : {})});
    }
  }
  const texts = props.filter(prop => prop.kind === 'text');
  if (rootKind === 'field') {
    // The text inside the field's box is what the input shows before anything is typed. A variant ("State=Error") is
    // read under its component's name, as rootKindOf reads it.
    for (const variant of variantNodes) {
      const parts = fieldParts(doc, {...variant, name});
      const value = parts ? doc.nodes[parts.value] : undefined;
      const key = value?.componentPropertyReferences?.characters;
      const prop = key ? texts.find(text => text.key === key) : undefined;
      if (prop) {
        prop.native = 'placeholder';
        prop.jsName = 'placeholder';
        break;
      }
    }
  } else if ((rootKind === 'button' || rootKind === 'plain') && texts.length === 1 && !texts[0].optional) {
    // One label: <Button>Buy</Button>, as long as no other text of the component is a prop.
    const total = variantNodes.reduce((most, variant) => Math.max(most, countTexts(doc, variant)), 0);
    if (rootKind === 'button' || total <= 1) {
      texts[0].native = 'children';
      texts[0].jsName = 'children';
    }
  }
}

/** The only visible text of a component (not inside a nested instance), or null. */
function soleText(doc: DesignDocument, node: SceneNode): SceneNode | null {
  let found: SceneNode | null = null;
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const n = doc.nodes[stack.pop()!];
    if (!n || n.visible === false || n.type === 'INSTANCE') continue;
    if (n.type === 'TEXT' && n.text) {
      if (found || n.componentPropertyReferences?.characters) return null;
      found = n;
    }
    if (n.children) stack.push(...n.children);
  }
  return found;
}

/** The texts of a variant (not inside a nested instance). */
function textsOf(doc: DesignDocument, node: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const n = doc.nodes[stack.pop()!];
    if (!n || n.type === 'INSTANCE') continue;
    if (n.type === 'TEXT' && n.text) out.push(n);
    if (n.children) stack.push(...n.children);
  }
  return out;
}

function countTexts(doc: DesignDocument, node: SceneNode): number {
  let count = 0;
  const stack = [node.id];
  while (stack.length) {
    const n = doc.nodes[stack.pop()!];
    if (!n || n.visible === false) continue;
    if (n.type === 'TEXT') count++;
    if (n.children && n.type !== 'INSTANCE') stack.push(...n.children);
  }
  return count;
}

export type StateApi = {
  /** The looks of the state property that are not interaction states, as the component takes them: a boolean for one
   *  besides the default (`error`), a union for several (`state?: 'default' | 'error' | 'loading'`), null for none. */
  prop: PropDef | null;
  /** The property has a disabled look: the component takes `disabled`. */
  disabled: boolean;
};

const stateApis = new WeakMap<ComponentModel, StateApi>();

/** The props a component's interaction-state property becomes (one object per model, so names stay put). */
export function stateApi(model: ComponentModel): StateApi {
  const cached = stateApis.get(model);
  if (cached) return cached;
  let api: StateApi = {prop: null, disabled: false};
  const state = model.state;
  if (state) {
    const prop = model.variantProps[state.prop];
    const looks = prop.options.filter(option => state.of.get(option.id) === 'rest');
    const others = looks.filter(option => option.id !== state.rest);
    const restOption = prop.options.find(option => option.id === state.rest)!;
    const taken = new Set(model.props.filter(other => other !== prop).map(other => other.jsName));
    let derived: PropDef | null = null;
    if (others.length === 1) {
      let name = memberName(others[0].value, others[0].id);
      if (taken.has(name) || ['className', 'style', 'children', 'disabled', 'checked'].includes(name)) name = 'is' + name[0].toUpperCase() + name.slice(1);
      derived = {key: prop.key, jsName: name, kind: 'variantBool', original: `${prop.original}: ${others[0].value}`, options: [{value: others[0].value, id: 'true'}, {value: restOption.value, id: 'false'}], defaultRaw: false};
    } else if (others.length > 1) {
      derived = {...prop, options: looks, defaultRaw: state.rest};
    }
    api = {prop: derived, disabled: state.states.has('disabled')};
  }
  stateApis.set(model, api);
  return api;
}

/** The TypeScript type of a prop. */
export function propType(prop: PropDef): string {
  switch (prop.kind) {
    case 'variant': return prop.tristate ? "boolean | 'mixed'" : prop.options.map(option => (prop.numeric ? option.id : `'${option.id}'`)).join(' | ') || 'string';
    case 'variantBool':
    case 'boolean': return 'boolean';
    case 'text': return prop.native === 'children' ? 'ReactNode' : 'string';
    case 'slot': return 'ReactNode';
  }
}

/** A variant option as a JS literal: `'small'`, or `40` for a numeric prop. */
export const optionLiteral = (prop: PropDef, id: string) => (prop.numeric || (prop.tristate && id !== 'mixed') ? id : `'${id}'`);

/** Designer's words inside a generated `/** … *\/` comment: one line, and never the comment's end, so a
 *  property or variant name cannot close the comment and put code into the exported project. */
const commentSafe = (text: string) => text.replace(/\s+/g, ' ').replace(/\*\//g, '* /');

/** The doc comment of a prop: the designer's name and, for variants, each value's original. */
export function propComment(prop: PropDef): string {
  const name = `"${commentSafe(prop.original)}"`;
  if (prop.kind === 'variant') {
    // Values that read the same in code need no gloss: "primary" for "Primary".
    const glossed = prop.options.filter(option => normal(option.value) !== normal(option.id));
    return glossed.length ? `${name}: ${glossed.map(option => `${optionLiteral(prop, option.id)} — "${commentSafe(option.value)}"`).join(', ')}` : name;
  }
  if (prop.kind === 'variantBool') return `${name}: true — "${commentSafe(prop.options[0].value)}", false — "${commentSafe(prop.options[1].value)}"`;
  if (prop.kind === 'slot') return prop.optional ? `${name}: shown when set` : `${name} (instance swap)`;
  if (prop.kind === 'boolean') return `${name} (show layer)`;
  if (prop.optional) return `${name}: shown when set`;
  return name;
}
