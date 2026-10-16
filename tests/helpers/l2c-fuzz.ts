// A document generator for the instance and variable stages (the general one is tests/helpers/design-fuzz.ts): seeded documents
// rich in what the instance and variable stages read — components with nested instances, variant sets, BOOLEAN /
// TEXT / INSTANCE_SWAP properties bound to layers, exposed instances, instances with overrides at every depth,
// variable collections with modes, alias chains up to depth 8, bound fields and paints, modes picked per node —
// and `mutate`, one random edit of the kind a transaction makes, with the dirty ids normalize would pass on.
// Deterministic by seed.

import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../../shared/design/defaults';
import type {AutoLayout, DesignDocument, NodeId, Paint, SceneNode, VariableType, VariableValue} from '../../shared/design/types';
import {
  addComponentProperty, bindProperty, createComponent, createInstance, setInstanceProperty, swapInstance, withOverrideTracking,
} from '../../shared/design/components';
import {combineAsVariants} from '../../shared/design/variants';
import {bindPaintVariable, bindVariable, createVariable, createVariableCollection, setNodeVariableMode, setVariableValue} from '../../shared/design/variables';
import {normalizeDocument} from '../../shared/design/normalize';
import {testMeasurer} from './design-big-files';

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  /** A number of the kinds documents hold: integers, halves, long fractions. */
  num(min: number, max: number): number {
    const kind = this.int(4);
    const raw = min + this.next() * (max - min);
    return kind === 0 ? Math.round(raw) : kind === 1 ? Math.round(raw * 2) / 2 : kind === 2 ? Math.round(raw * 1000) / 1000 : raw;
  }
}

const WORDS = ['Pill', 'Glyph', 'Copy', 'Backdrop', 'Chip', 'Card', 'Button', 'Icon', 'Label', 'Box'];
const color = (rng: Rng) => ({r: rng.int(256) / 255, g: rng.int(256) / 255, b: rng.int(256) / 255});

type Builder = {doc: DesignDocument; rng: Rng; n: number};

function add(b: Builder, type: SceneNode['type'], parentId: NodeId, props: Partial<SceneNode> = {}): NodeId {
  const id = `f${++b.n}`;
  const node = createNode(type, {...props, id, parentId});
  b.doc.nodes[id] = node;
  b.doc.nodes[parentId] = {...b.doc.nodes[parentId], children: [...(b.doc.nodes[parentId].children ?? []), id]};
  return id;
}

function autoLayout(rng: Rng): AutoLayout {
  return {...defaultAutoLayout(rng.chance(0.5) ? 'HORIZONTAL' : 'VERTICAL'), itemSpacing: rng.num(0, 24), paddingLeft: rng.num(0, 16), paddingTop: rng.num(0, 16), paddingRight: rng.int(8), paddingBottom: rng.int(8)};
}

/** A main component's content: shapes, text, a vector, a group, a nested frame (maybe auto layout). */
function fillComponent(b: Builder, frameId: NodeId, depth: number): void {
  const {rng} = b;
  const count = 1 + rng.int(5);
  const frame = b.doc.nodes[frameId];
  const flow = !!frame.autoLayout && frame.autoLayout.layoutMode !== 'NONE';
  for (let i = 0; i < count; i++) {
    const kind = rng.int(8);
    const base: Partial<SceneNode> = {
      name: rng.pick(WORDS) + (rng.chance(0.3) ? '' : ` ${i + 1}`),
      x: rng.num(0, 200), y: rng.num(0, 120), width: rng.num(1, 160), height: rng.num(1, 80),
      constraints: {horizontal: rng.pick(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'] as const), vertical: rng.pick(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'] as const)},
      ...(rng.chance(0.1) ? {rotation: rng.pick([90, -45, 30, 180, 12.5])} : {}),
      ...(flow && rng.chance(0.3) ? {layoutSizingHorizontal: rng.pick(['FILL', 'HUG', 'FIXED'] as const)} : {}),
      ...(flow && rng.chance(0.15) ? {layoutPositioning: 'ABSOLUTE' as const} : {}),
    };
    if (kind <= 1) add(b, 'RECTANGLE', frameId, {...base, fills: [solid(color(rng))], cornerRadius: rng.int(12)});
    else if (kind === 2) {
      const text = {...defaultTextProps(rng.pick(['Hi there', 'Hello', 'Button text', 'A', 'A long label text']))};
      text.textAutoResize = rng.pick(['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE'] as const);
      if (rng.chance(0.3)) text.runs = [{start: 0, end: Math.min(3, text.characters.length), style: {fontWeight: 700}, ...(rng.chance(0.5) ? {fills: [solid(color(rng))]} : {})}];
      add(b, 'TEXT', frameId, {...base, text, layoutSizingHorizontal: text.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'HUG' : base.layoutSizingHorizontal ?? 'FIXED', layoutSizingVertical: text.textAutoResize === 'NONE' ? 'FIXED' : 'HUG'});
    } else if (kind === 3) add(b, 'ELLIPSE', frameId, base);
    else if (kind === 4) add(b, 'VECTOR', frameId, {...base, vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: base.width!, y: base.height! / 2}, {type: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: base.width! / 3, y: base.height!}, {type: 'Z'}]}]});
    else if (kind === 5 && depth < 2) {
      const group = add(b, 'GROUP', frameId, base);
      add(b, 'RECTANGLE', group, {x: 0, y: 0, width: base.width, height: base.height, name: 'Inside'});
      add(b, 'ELLIPSE', group, {x: 2, y: 2, width: 10, height: 10});
    } else if (kind === 6 && depth < 2) {
      const inner = add(b, 'FRAME', frameId, {...base, ...(rng.chance(0.5) ? {autoLayout: autoLayout(rng), layoutSizingVertical: 'HUG' as const} : {})});
      fillComponent(b, inner, depth + 1);
    } else add(b, 'LINE', frameId, {...base, height: 0});
  }
}

/** One fuzzed document, normalized. */
export function fuzzDocument(seed: number, size: 'small' | 'medium' = 'small'): DesignDocument {
  const rng = new Rng(seed * 7919 + 13);
  const b: Builder = {doc: createDocument('page', 'Screen'), rng, n: 0};
  const cpage = createNode('PAGE', {id: 'cpage', name: 'Components', children: []});
  b.doc = {...b.doc, pages: ['page', 'cpage'], nodes: {...b.doc.nodes, cpage}};
  const step = <T extends {doc: DesignDocument}>(run: () => T): T | null => {
    try {
      const result = run();
      b.doc = result.doc;
      return result;
    } catch {
      return null;
    }
  };

  // ── Main components, some with instances of earlier ones inside ──
  const components: NodeId[] = [];
  const total = (size === 'small' ? 3 : 6) + rng.int(4);
  for (let c = 0; c < total; c++) {
    const frame = add(b, 'FRAME', 'cpage', {name: rng.pick(WORDS), x: c * 300, y: 0, width: rng.num(80, 260), height: rng.num(40, 160), fills: [solid(color(rng))], ...(rng.chance(0.4) ? {autoLayout: autoLayout(rng), layoutSizingHorizontal: rng.pick(['HUG', 'FIXED'] as const), layoutSizingVertical: 'HUG' as const} : {})});
    fillComponent(b, frame, 0);
    step(() => createComponent(b.doc, [frame]));
    if (b.doc.nodes[frame]?.type !== 'COMPONENT') continue;
    components.push(frame);
    // Nested instances of earlier components (never a cycle: only earlier ones).
    const earlier = components.slice(0, -1);
    if (earlier.length && rng.chance(0.6)) {
      for (let k = 0, m = 1 + rng.int(2); k < m; k++) {
        const target = rng.pick(earlier);
        const made = step(() => createInstance(b.doc, target, {parentId: frame, x: rng.num(0, 60), y: rng.num(0, 60), newId: `f${++b.n}`}));
        if (made && rng.chance(0.4)) b.doc = {...b.doc, nodes: {...b.doc.nodes, [made.id]: {...b.doc.nodes[made.id], isExposedInstance: true}}};
      }
    }
  }

  // ── Variant sets ──
  const sets: NodeId[] = [];
  const loose = components.filter(id => b.doc.nodes[id]?.type === 'COMPONENT');
  for (let s = 0; s + 1 < loose.length && s < 2; s++) {
    if (!rng.chance(0.7)) continue;
    const members = loose.splice(0, 2 + rng.int(2)).filter(id => b.doc.nodes[id]?.parentId === 'cpage');
    if (members.length < 2) continue;
    members.forEach((id, i) => {
      const name = rng.chance(0.8) ? `Size=${['S', 'M', 'L'][i % 3]}, State=${i % 2 ? 'On' : 'Off'}` : rng.pick(WORDS);
      b.doc = {...b.doc, nodes: {...b.doc.nodes, [id]: {...b.doc.nodes[id], name}}};
    });
    const made = step(() => combineAsVariants(b.doc, members, `set${s}`));
    if (made) sets.push(made.setId);
  }

  // ── Properties bound to layers ──
  for (const componentId of components) {
    const component = b.doc.nodes[componentId];
    if (component?.type !== 'COMPONENT' || !rng.chance(0.7)) continue;
    const children = (component.children ?? []).map(id => b.doc.nodes[id]).filter(Boolean);
    const text = children.find(node => node.type === 'TEXT');
    if (text && rng.chance(0.7)) {
      const made = step(() => addComponentProperty(b.doc, componentId, {name: rng.pick(['Caption', 'Label', 'Text']), type: 'TEXT', defaultValue: rng.pick(['Initial', 'Default', ''])}));
      if (made) step(() => bindProperty(b.doc, text.id, 'characters', made.key));
    }
    const shape = rng.pick(children);
    if (shape && rng.chance(0.6)) {
      const made = step(() => addComponentProperty(b.doc, componentId, {name: rng.pick(['Reveal', 'Show', 'Icon']), type: 'BOOLEAN', defaultValue: rng.chance(0.7)}));
      if (made) step(() => bindProperty(b.doc, shape.id, 'visible', made.key));
    }
    const nested = children.find(node => node.type === 'INSTANCE');
    if (nested && rng.chance(0.7)) {
      const others = components.filter(id => id !== componentId && components.indexOf(id) < components.indexOf(componentId));
      if (others.length) {
        const made = step(() => addComponentProperty(b.doc, componentId, {name: rng.pick(['Replace', 'Swap']), type: 'INSTANCE_SWAP', defaultValue: rng.pick(others)}));
        if (made) step(() => bindProperty(b.doc, nested.id, 'mainComponent', made.key));
      }
    }
  }

  // ── Instances on the page, in plain and auto-layout frames ──
  const holders: NodeId[] = ['page'];
  for (let h = 0; h < 2 + rng.int(3); h++) {
    holders.push(add(b, 'FRAME', 'page', {name: `Screen ${h}`, x: h * 500, y: 400, width: 480, height: 600, ...(rng.chance(0.5) ? {autoLayout: autoLayout(rng)} : {})}));
  }
  const targets = [...components, ...sets].filter(id => b.doc.nodes[id]);
  const instances: NodeId[] = [];
  const count = (size === 'small' ? 4 : 12) + rng.int(8);
  for (let i = 0; i < count && targets.length; i++) {
    const made = step(() => createInstance(b.doc, rng.pick(targets), {parentId: rng.pick(holders), x: rng.num(0, 300), y: rng.num(0, 300), newId: `i${i}`}));
    if (made) instances.push(made.id);
  }

  // ── Property values, swaps and overrides ──
  for (const id of instances) {
    const instance = b.doc.nodes[id];
    if (!instance) continue;
    if (rng.chance(0.4)) {
      const props = instance.componentProperties ?? {};
      const keys = Object.keys(props);
      if (keys.length) {
        const key = rng.pick(keys);
        const value = typeof props[key] === 'boolean' ? !props[key] : rng.pick(['Mine', 'Other text', ...targets]);
        step(() => setInstanceProperty(b.doc, id, key, value));
      }
    }
    if (rng.chance(0.15)) step(() => swapInstance(b.doc, id, rng.pick(targets)));
    const overrides = rng.int(4);
    for (let o = 0; o < overrides; o++) overrideCopy(b, id);
  }

  // ── Variables ──
  addVariables(b, size);
  return normalizeDocument(b.doc, new Set(Object.keys(b.doc.nodes)), {measurer: testMeasurer});
}

/** Every node under (and including) `rootId`. */
function subtree(doc: DesignDocument, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    out.push(id);
    if (node.children) stack.push(...node.children);
  }
  return out;
}

const write = (b: Builder, id: NodeId, partial: Partial<SceneNode>) => {
  const node = b.doc.nodes[id];
  if (!node) return;
  const next = {...node, ...partial} as Record<string, unknown>;
  for (const key in partial) if ((partial as Record<string, unknown>)[key] === undefined) delete next[key];
  b.doc = {...b.doc, nodes: {...b.doc.nodes, [id]: next as unknown as SceneNode}};
};

/** An edit on a copy (or the instance), recorded as an override the way the editor records it. */
function overrideCopy(b: Builder, instanceId: NodeId): NodeId | null {
  const {rng} = b;
  const ids = subtree(b.doc, instanceId);
  const id = rng.pick(ids);
  const node = b.doc.nodes[id];
  if (!node) return null;
  let partial: Partial<SceneNode>;
  const kind = rng.int(12);
  if (kind === 0) partial = {fills: [solid(color(rng))]};
  else if (kind === 1) partial = {name: rng.pick(WORDS) + ' *'};
  else if (kind === 2) partial = {x: node.x + rng.num(-20, 20), y: node.y + rng.num(-10, 10)};
  else if (kind === 3) partial = {width: rng.num(5, 200), height: rng.num(5, 120)};
  else if (kind === 4) partial = {visible: !node.visible};
  else if (kind === 5 && node.text) partial = {text: {...node.text, characters: rng.pick(['Edited', 'Changed', 'Ok', ''])}};
  else if (kind === 6 && node.text) partial = {text: {...node.text, style: {...node.text.style, fontSize: rng.pick([12, 14, 20, 32])}}};
  else if (kind === 7 && node.autoLayout) partial = {autoLayout: {...node.autoLayout, itemSpacing: rng.num(0, 40)}};
  else if (kind === 8) partial = {opacity: rng.pick([0.5, 0.25, 1, 0.8])};
  else if (kind === 9 && node.type === 'INSTANCE' && node.mainId !== undefined) {
    const targets = Object.values(b.doc.nodes).filter(other => other.type === 'COMPONENT').map(other => other.id);
    if (!targets.length) return null;
    try {
      b.doc = swapInstance(b.doc, id, rng.pick(targets)).doc;
    } catch {
      return null;
    }
    return id;
  } else if (kind === 10) partial = {cornerRadius: rng.int(20), strokes: [solid(color(rng))], strokeWeight: rng.pick([1, 2, 4])};
  else partial = {layoutSizingHorizontal: rng.pick(['FIXED', 'HUG', 'FILL'] as const), constraints: {horizontal: 'MAX', vertical: 'CENTER'}};
  write(b, id, withOverrideTracking(b.doc, id, partial, {direct: true}));
  return id;
}

function addVariables(b: Builder, size: 'small' | 'medium'): void {
  const {rng} = b;
  const collections: {id: string; modes: string[]}[] = [];
  for (let c = 0, m = 1 + rng.int(size === 'small' ? 2 : 3); c < m; c++) {
    const id = `col${c}`;
    const modes = Array.from({length: 1 + rng.int(3)}, (_, i) => ({modeId: `${id}:m${i}`, name: `Mode ${i}`}));
    try {
      b.doc = createVariableCollection(b.doc, {id, name: `Collection ${c}`, modes}).doc;
      collections.push({id, modes: modes.map(mode => mode.modeId)});
    } catch {
      /* skipped */
    }
  }
  if (!collections.length) return;
  const variables: {id: string; type: VariableType; collection: string}[] = [];
  const value = (type: VariableType): VariableValue =>
    type === 'COLOR' ? {...color(rng), a: rng.pick([1, 0.5, 0.8])} : type === 'FLOAT' ? rng.pick([0, 4, 8, 12.5, 16, 24, 50, 100, -3]) : type === 'STRING' ? rng.pick(['Inter', 'Hi there', 'Roboto', '', 'Copy']) : rng.chance(0.5);
  const count = (size === 'small' ? 8 : 20) + rng.int(10);
  for (let v = 0; v < count; v++) {
    const collection = rng.pick(collections);
    const type = rng.pick(['COLOR', 'FLOAT', 'FLOAT', 'STRING', 'BOOLEAN'] as const);
    const id = `v${v}`;
    try {
      b.doc = createVariable(b.doc, {id, name: `Variable ${v}`, collectionId: collection.id, type, value: value(type)}).doc;
      variables.push({id, type, collection: collection.id});
      for (const mode of collection.modes) if (rng.chance(0.5)) b.doc = setVariableValue(b.doc, id, mode, value(type)).doc;
    } catch {
      /* skipped */
    }
  }
  // Alias chains (same or other collection), up to depth 8.
  for (const variable of variables) {
    if (!rng.chance(0.45)) continue;
    const sameType = variables.filter(other => other.type === variable.type && other.id !== variable.id);
    if (!sameType.length) continue;
    const collection = collections.find(each => each.id === variable.collection)!;
    try {
      b.doc = setVariableValue(b.doc, variable.id, rng.pick(collection.modes), {type: 'VARIABLE_ALIAS', id: rng.pick(sameType).id}).doc;
    } catch {
      /* a cycle: skipped */
    }
  }
  // Bindings on mains, copies and plain layers.
  const fields: Record<VariableType, string[]> = {
    FLOAT: ['width', 'height', 'opacity', 'cornerRadius', 'itemSpacing', 'paddingLeft', 'strokeWeight', 'topLeftRadius', 'strokeTopWeight', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paragraphSpacing', 'minWidth'],
    STRING: ['characters', 'fontFamily'],
    BOOLEAN: ['visible'],
    COLOR: [],
  };
  const nodes = Object.keys(b.doc.nodes).filter(id => b.doc.nodes[id].type !== 'PAGE');
  const bindings = (size === 'small' ? 10 : 40) + rng.int(20);
  for (let k = 0; k < bindings && nodes.length && variables.length; k++) {
    const id = rng.pick(nodes);
    const variable = rng.pick(variables);
    const node = b.doc.nodes[id];
    if (!node) continue;
    try {
      if (variable.type === 'COLOR') {
        const target = rng.chance(0.7) ? 'fills' : 'strokes';
        const index = node[target].findIndex((paint: Paint) => paint.type === 'SOLID');
        if (index >= 0) b.doc = bindPaintVariable(b.doc, id, target, index, variable.id).doc;
        else if (node.text?.runs.some(run => run.fills?.length)) {
          const runs = node.text.runs.map(run => (run.fills?.length && run.fills[0].type === 'SOLID' ? {...run, fills: [{...run.fills[0], boundVariables: {color: {type: 'VARIABLE_ALIAS' as const, id: variable.id}}}]} : run));
          write(b, id, {text: {...node.text, runs}});
        }
      } else {
        const field = rng.pick(fields[variable.type]);
        const bound = b.doc.nodes[id].mainId !== undefined || b.doc.nodes[id].type === 'INSTANCE';
        const before = b.doc;
        b.doc = bindVariable(b.doc, id, field, variable.id).doc;
        if (bound) {
          // Inside an instance the binding is an override, as the editor records it.
          const next = b.doc.nodes[id];
          b.doc = before;
          write(b, id, withOverrideTracking(before, id, {boundVariables: next.boundVariables, ...diffFields(before.nodes[id], next)}, {direct: true}));
        }
      }
    } catch {
      /* not bindable here */
    }
  }
  // Modes picked on frames, instances, components and copies.
  const frames = Object.keys(b.doc.nodes).filter(id => ['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(b.doc.nodes[id].type));
  for (let k = 0, m = 1 + rng.int(6); k < m && frames.length; k++) {
    const collection = rng.pick(collections);
    try {
      b.doc = setNodeVariableMode(b.doc, rng.pick(frames), collection.id, rng.pick(collection.modes)).doc;
    } catch {
      /* skipped */
    }
  }
}

function diffFields(before: SceneNode, after: SceneNode): Partial<SceneNode> {
  const out: Record<string, unknown> = {};
  const a = before as unknown as Record<string, unknown>, c = after as unknown as Record<string, unknown>;
  for (const key of Object.keys(c)) if (key !== 'boundVariables' && a[key] !== c[key]) out[key] = c[key];
  return out as Partial<SceneNode>;
}

// ── Mutations ────────────────────────────────────────────────────────────────────────────────────────

export type Mutation = {doc: DesignDocument; dirty: Set<string>; kind: string};

const mains = (doc: DesignDocument) => Object.values(doc.nodes).filter(node => node.type === 'COMPONENT');

/** Nodes inside main components (not inside instances). */
function mainLayers(doc: DesignDocument): SceneNode[] {
  const out: SceneNode[] = [];
  for (const main of mains(doc)) {
    const stack = [...(main.children ?? [])];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node || node.mainId !== undefined) continue;
      out.push(node);
      if (node.children && node.type !== 'INSTANCE') stack.push(...node.children);
    }
  }
  return out;
}

/** One random edit and the ids a transaction would mark dirty (changed, created, the parents of removed or moved). */
export function mutate(doc: DesignDocument, rng: Rng): Mutation {
  // A table of its own: `add` writes into it in place.
  const b: Builder = {doc: {...doc, nodes: {...doc.nodes}}, rng, n: 100_000 + rng.int(1_000_000)};
  const dirty = new Set<string>();
  const ids = Object.keys(doc.nodes);
  const kind = rng.int(20);
  const layers = mainLayers(doc);
  const components = mains(doc);
  const instances = Object.values(doc.nodes).filter(node => node.type === 'INSTANCE');
  const copies = Object.values(doc.nodes).filter(node => node.mainId !== undefined);
  const name = ['edit-main', 'resize-main', 'add-child', 'remove-child', 'reorder', 'override', 'swap', 'property', 'rename-variant',
    'variable-value', 'mode', 'random-dirty', 'unsynced', 'reference', 'move-in-main', 'garbage-overrides', 'definitions', 'remove-main', 'edit-main', 'all-dirty'][kind];
  const touch = (id: NodeId, partial: Partial<SceneNode>) => {
    write(b, id, partial);
    dirty.add(id);
  };
  switch (name) {
    case 'edit-main': {
      const node = layers.length ? rng.pick(layers) : null;
      if (!node) break;
      const field = rng.int(9);
      if (field === 0) touch(node.id, {fills: [solid(color(rng))]});
      else if (field === 1) touch(node.id, {x: node.x + rng.num(-30, 30), width: Math.max(0, node.width + rng.num(-20, 40))});
      else if (field === 2) touch(node.id, {name: rng.pick(WORDS)});
      else if (field === 3) touch(node.id, {visible: !node.visible});
      else if (field === 4 && node.text) touch(node.id, {text: {...node.text, characters: rng.pick(['Fresh', 'New text', 'Z', ''])}});
      else if (field === 5) touch(node.id, {opacity: rng.pick([0.3, 0.7, 1])});
      else if (field === 6 && node.autoLayout) touch(node.id, {autoLayout: {...node.autoLayout, itemSpacing: rng.num(0, 30), paddingTop: rng.int(10)}});
      else if (field === 7) touch(node.id, {constraints: {horizontal: rng.pick(['MIN', 'MAX', 'STRETCH', 'SCALE', 'CENTER'] as const), vertical: rng.pick(['MIN', 'MAX', 'STRETCH', 'SCALE', 'CENTER'] as const)}});
      else touch(node.id, {rotation: rng.pick([0, 45, 90, -30]), height: Math.max(0, node.height + rng.num(-10, 10))});
      break;
    }
    case 'resize-main': {
      const main = components.length ? rng.pick(components) : null;
      if (main) touch(main.id, {width: Math.max(1, main.width + rng.num(-60, 80)), height: Math.max(1, main.height + rng.num(-40, 60))});
      break;
    }
    case 'add-child': {
      const parents = [...components, ...layers.filter(node => node.type === 'FRAME' || node.type === 'GROUP')];
      if (!parents.length) break;
      const parent = rng.pick(parents);
      const id = add(b, rng.pick(['RECTANGLE', 'ELLIPSE', 'TEXT'] as const), parent.id, {name: rng.pick(WORDS), x: rng.num(0, 50), y: rng.num(0, 50), width: rng.num(1, 50), height: rng.num(1, 50)});
      if (b.doc.nodes[id].type === 'TEXT') write(b, id, {text: defaultTextProps('Fresh')});
      dirty.add(id);
      dirty.add(parent.id);
      break;
    }
    case 'remove-child': {
      const node = layers.length ? rng.pick(layers) : null;
      if (!node?.parentId) break;
      const parent = b.doc.nodes[node.parentId];
      touch(parent.id, {children: (parent.children ?? []).filter(id => id !== node.id)});
      const nodes = {...b.doc.nodes};
      for (const id of subtree(b.doc, node.id)) {
        delete nodes[id];
        dirty.add(id);
      }
      b.doc = {...b.doc, nodes};
      break;
    }
    case 'reorder': {
      const parents = [...components, ...layers].filter(node => (node.children?.length ?? 0) > 1);
      if (!parents.length) break;
      const parent = rng.pick(parents);
      const children = [...parent.children!];
      children.push(children.shift()!);
      touch(parent.id, {children});
      break;
    }
    case 'override': {
      if (!instances.length) break;
      const id = overrideCopy(b, rng.pick(instances).id);
      if (id) dirty.add(id);
      break;
    }
    case 'swap': {
      const node = instances.length ? rng.pick(instances) : null;
      const targets = components.map(main => main.id);
      if (!node || !targets.length) break;
      // A raw componentId change (an import, a remote edit) or a recorded one.
      if (rng.chance(0.5)) touch(node.id, {componentId: rng.pick(targets)});
      else {
        try {
          b.doc = swapInstance(b.doc, node.id, rng.pick(targets)).doc;
          dirty.add(node.id);
        } catch {
          /* a cycle */
        }
      }
      break;
    }
    case 'property': {
      const node = instances.length ? rng.pick(instances) : null;
      if (!node?.componentProperties) break;
      const keys = Object.keys(node.componentProperties);
      if (!keys.length) break;
      const key = rng.pick(keys);
      const current = node.componentProperties[key];
      const value = typeof current === 'boolean' ? !current : rng.pick(['My value', 'X', ...components.map(main => main.id)]);
      if (rng.chance(0.5)) {
        touch(node.id, {componentProperties: {...node.componentProperties, [key]: value}, overrides: [...(node.overrides ?? []), `componentProperties.${key}`]});
      } else {
        try {
          b.doc = setInstanceProperty(b.doc, node.id, key, value).doc;
          dirty.add(node.id);
        } catch {
          /* wrong type */
        }
      }
      break;
    }
    case 'rename-variant': {
      const variants = components.filter(main => doc.nodes[main.parentId ?? '']?.type === 'COMPONENT_SET');
      if (!variants.length) break;
      const variant = rng.pick(variants);
      touch(variant.id, {name: rng.chance(0.7) ? `Size=${rng.pick(['S', 'M', 'L', 'XL'])}, State=${rng.pick(['On', 'Off', 'Hover'])}` : rng.pick(['Bad name', 'a=1, b', 'Type=New'])});
      break;
    }
    case 'variable-value': {
      const variables = Object.values(doc.variables);
      if (!variables.length) break;
      const variable = rng.pick(variables);
      const collection = doc.variableCollections[variable.collectionId];
      if (!collection) break;
      const mode = rng.pick(collection.modes).modeId;
      const value: VariableValue = variable.type === 'COLOR' ? {...color(rng), a: 1} : variable.type === 'FLOAT' ? rng.pick([2, 10, 33.3, -1, 0]) : variable.type === 'STRING' ? rng.pick(['Newer', 'Arial']) : rng.chance(0.5);
      b.doc = {...b.doc, variables: {...b.doc.variables, [variable.id]: {...variable, valuesByMode: {...variable.valuesByMode, [mode]: value}}}};
      dirty.add(variable.id);
      if (rng.chance(0.2)) dirty.add(collection.id);
      break;
    }
    case 'mode': {
      const collections = Object.values(doc.variableCollections);
      const frames = ids.filter(id => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(doc.nodes[id].type));
      if (!collections.length || !frames.length) break;
      const collection = rng.pick(collections);
      const id = rng.pick(frames);
      const modes = {...(b.doc.variableModes ?? {})};
      if (rng.chance(0.3)) delete modes[id];
      else modes[id] = {...(modes[id] ?? {}), [collection.id]: rng.pick(collection.modes).modeId};
      b.doc = {...b.doc, variableModes: modes};
      dirty.add(id);
      break;
    }
    case 'random-dirty': {
      for (let k = 0, m = 1 + rng.int(8); k < m; k++) dirty.add(rng.pick(ids));
      const variables = Object.keys(doc.variables);
      if (variables.length && rng.chance(0.3)) dirty.add(rng.pick(variables));
      break;
    }
    case 'unsynced': {
      const node = instances.filter(each => each.mainId === undefined);
      if (!node.length) break;
      const instance = rng.pick(node);
      const nodes = {...b.doc.nodes};
      for (const id of subtree(b.doc, instance.id)) if (id !== instance.id) delete nodes[id];
      nodes[instance.id] = {...instance, children: []};
      b.doc = {...b.doc, nodes};
      dirty.add(instance.id);
      break;
    }
    case 'reference': {
      const node = layers.length ? rng.pick(layers) : null;
      if (!node) break;
      if (node.componentPropertyReferences && rng.chance(0.5)) touch(node.id, {componentPropertyReferences: undefined});
      else touch(node.id, {componentPropertyReferences: {...(node.componentPropertyReferences ?? {}), visible: rng.pick(['Reveal#1', 'None#9', 'Show#2'])}});
      break;
    }
    case 'move-in-main': {
      const containers = [...components, ...layers.filter(node => node.type === 'FRAME')];
      const node = layers.length ? rng.pick(layers) : null;
      if (!node?.parentId || containers.length < 2) break;
      const target = rng.pick(containers);
      if (target.id === node.id || subtree(b.doc, node.id).includes(target.id) || target.id === node.parentId) break;
      const from = b.doc.nodes[node.parentId];
      touch(from.id, {children: (from.children ?? []).filter(id => id !== node.id)});
      touch(target.id, {children: [...(b.doc.nodes[target.id].children ?? []), node.id]});
      touch(node.id, {parentId: target.id});
      break;
    }
    case 'garbage-overrides': {
      const node = copies.length ? rng.pick(copies) : null;
      if (!node) break;
      const entries = ['x', 'fills', 'text.characters', 'componentId', 'componentProperties.None#1', 'autoLayout.itemSpacing', 'boundVariables.width', 'name', 'text', 'fills.0', 'componentProperties'];
      touch(node.id, {overrides: Array.from({length: 1 + rng.int(3)}, () => rng.pick(entries))});
      break;
    }
    case 'definitions': {
      const owners = Object.values(doc.nodes).filter(node => (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.componentPropertyDefinitions && Object.keys(node.componentPropertyDefinitions).length);
      if (!owners.length) break;
      const owner = rng.pick(owners);
      const defs = {...owner.componentPropertyDefinitions!};
      const key = rng.pick(Object.keys(defs));
      const def = defs[key];
      if (def.type === 'BOOLEAN') defs[key] = {...def, defaultValue: !def.defaultValue};
      else if (def.type === 'TEXT') defs[key] = {...def, defaultValue: rng.pick(['Newer', ''])};
      else if (rng.chance(0.5)) delete defs[key];
      touch(owner.id, {componentPropertyDefinitions: defs});
      break;
    }
    case 'remove-main': {
      const main = components.length ? rng.pick(components) : null;
      if (!main?.parentId) break;
      const parent = b.doc.nodes[main.parentId];
      touch(parent.id, {children: (parent.children ?? []).filter(id => id !== main.id)});
      const nodes = {...b.doc.nodes};
      for (const id of subtree(b.doc, main.id)) {
        delete nodes[id];
        dirty.add(id);
      }
      b.doc = {...b.doc, nodes};
      break;
    }
    case 'all-dirty': {
      for (const id of ids) if (rng.chance(0.5)) dirty.add(id);
      break;
    }
  }
  return {doc: b.doc, dirty, kind: name};
}
