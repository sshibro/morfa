import type {NodeId, NodeType} from '../types';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaFile, FigmaNode} from './rest-types';

// The Figma tree as an index, and the decisions that must be made before any node is written:
//
// • Which instances stay instances. A Figma instance whose main component is in the file stays one;
//   one whose component lives in another file (a library) or whose copies cannot be matched to their
//   main's nodes becomes a plain frame (its nested instances are judged on their own).
// • Every node's id in the new file. Plain nodes keep Figma's id ("12:34"). A node inside an instance
//   (Figma "I<instance>;<node>") gets our `${owner};${sourceId}` (shared/design/components.ts): the
//   owner is the top-level instance, or a nested one swapped to another component; the source is the
//   node of the main it mirrors, found through Figma's id chain: the last id segment is the node in
//   the nearest instance's component, and a nested instance that was not swapped hands on the source
//   path of its own main.
//
// Everything here works from Figma ids and types only, so decisions never depend on output order.

export type Entry = {
  node: FigmaNode;
  parent: Entry | null;
  /** The CANVAS this node is on (null for pages and for nodes read without their page). */
  page: Entry | null;
  /** The nearest INSTANCE ancestor. */
  instance: Entry | null;
  /** Levels below the page. */
  depth: number;
  /** Nodes in this subtree, itself included. */
  size: number;
};

const MAX_NODES_INDEXED = 2_000_000;

/** Figma ids may contain anything; ours are [A-Za-z0-9_:;.,-]. ";" is reserved for instance copies. */
export function plainId(figmaId: string): string {
  const id = figmaId.replace(/;/g, ',').replace(/[^A-Za-z0-9_:.,-]/g, '_').slice(0, L.id) || '_';
  // A map key "__proto__" would replace the map's prototype.
  return id === '__proto__' ? '_proto_' : id;
}
const strip = (figmaId: string) => (figmaId.startsWith('I') ? figmaId.slice(1) : figmaId);

export class FigmaIndex {
  readonly byId = new Map<string, Entry>();
  readonly pages: Entry[] = [];
  /** Component nodes read on their own (a big file read page by page): no page, no parent. */
  readonly loose: Entry[] = [];

  constructor(file: FigmaFile, extra: readonly FigmaNode[] = []) {
    const canvases = Array.isArray(file.document?.children) ? file.document!.children : [];
    for (const canvas of canvases) {
      if (!canvas || typeof canvas !== 'object' || canvas.type !== 'CANVAS' || typeof canvas.id !== 'string') continue;
      const entry = this.add(canvas, null, null);
      if (entry) this.pages.push(entry);
    }
    for (const node of extra) {
      if (!node || typeof node !== 'object' || typeof node.id !== 'string' || this.byId.has(node.id)) continue;
      const entry = this.add(node, null, null);
      if (entry) this.loose.push(entry);
    }
  }

  /** Adds a subtree iteratively (hostile nesting cannot exhaust the stack). */
  private add(root: FigmaNode, parent: Entry | null, page: Entry | null): Entry | null {
    if (this.byId.has(root.id)) return null;
    const top: Entry = {node: root, parent, page, instance: null, depth: 0, size: 1};
    this.byId.set(root.id, top);
    const order: Entry[] = [top];
    const stack: Entry[] = [top];
    while (stack.length) {
      const entry = stack.pop()!;
      const children = Array.isArray(entry.node.children) ? entry.node.children : [];
      const childPage = entry.node.type === 'CANVAS' ? entry : entry.page;
      for (const child of children) {
        if (!child || typeof child !== 'object' || typeof child.id !== 'string' || typeof child.type !== 'string' || this.byId.has(child.id)) continue;
        if (this.byId.size >= MAX_NODES_INDEXED) break;
        const instance = entry.node.type === 'INSTANCE' ? entry : entry.instance;
        const next: Entry = {node: child, parent: entry, page: childPage, instance, depth: entry.node.type === 'CANVAS' ? 0 : entry.depth + 1, size: 1};
        this.byId.set(child.id, next);
        order.push(next);
        stack.push(next);
      }
    }
    for (let i = order.length - 1; i > 0; i--) order[i].parent!.size += order[i].size;
    return top;
  }

  get(id: string | undefined | null): Entry | undefined {
    return typeof id === 'string' ? this.byId.get(id) : undefined;
  }

  /** The children of an entry that the index holds, in Figma's order (bottom to top). */
  children(entry: Entry): Entry[] {
    const out: Entry[] = [];
    for (const child of entry.node.children ?? []) {
      const found = child && typeof child.id === 'string' ? this.byId.get(child.id) : undefined;
      if (found && found.parent === entry) out.push(found);
    }
    return out;
  }
}

/** The Morfa type a Figma node becomes, before instance decisions. Null: not imported. */
export function mappedType(node: FigmaNode): NodeType | null {
  switch (node.type) {
    case 'FRAME': case 'GROUP': case 'SECTION': case 'COMPONENT': case 'COMPONENT_SET': case 'INSTANCE': case 'BOOLEAN_OPERATION':
    case 'RECTANGLE': case 'ELLIPSE': case 'LINE': case 'VECTOR': case 'TEXT': case 'SLICE':
      return node.type;
    case 'REGULAR_POLYGON':
      return typeof node.pointCount === 'number' && node.pointCount >= 3 ? 'POLYGON' : 'VECTOR';
    case 'STAR':
      return typeof node.pointCount === 'number' && node.pointCount >= 3 && typeof node.innerRadius === 'number' ? 'STAR' : 'VECTOR';
    case 'TABLE': case 'TABLE_CELL': case 'SHAPE_WITH_TEXT': case 'STICKY':
      return 'FRAME';
    case 'TEXT_PATH':
      return 'TEXT';
    case 'WASHI_TAPE': case 'HIGHLIGHT': case 'STAMP':
      return 'VECTOR';
    default:
      return null;
  }
}

type Decision = 'kept' | 'detached' | 'pending';

/** Instance decisions and ids over one index. */
export class InstancePlan {
  private readonly decisions = new Map<Entry, Decision>();
  private readonly why = new Map<Entry, 'remote' | 'missing' | 'mismatch'>();
  private readonly ids = new Map<Entry, NodeId>();

  constructor(readonly index: FigmaIndex, private readonly remote: (componentId: string) => boolean) {}

  // ── Copies ───────────────────────────────────────────────────────────────────────────────────

  /** Inside a kept instance (assuming `assumeKept` is kept while it is being judged). */
  isCopy(entry: Entry, assumeKept?: Entry): boolean {
    const instance = entry.instance;
    if (!instance) return false;
    if (this.isCopy(instance, assumeKept)) return true;
    return instance === assumeKept || !this.isDetached(instance);
  }

  isRootInstance(entry: Entry, assumeKept?: Entry): boolean {
    return entry.node.type === 'INSTANCE' && !this.isCopy(entry, assumeKept);
  }

  /** The node of a main a copy mirrors, or undefined when it cannot be found. */
  sourceOf(entry: Entry, assumeKept?: Entry): Entry | undefined {
    const instance = entry.instance;
    if (!instance) return undefined;
    const prefix = 'I' + strip(instance.node.id) + ';';
    if (!entry.node.id.startsWith(prefix)) return undefined;
    const segment = entry.node.id.slice(prefix.length);
    if (!segment || segment.includes(';')) return undefined;
    if (this.isRootInstance(instance, assumeKept) || this.isSwapped(instance, assumeKept)) return this.index.get(segment);
    const parentSource = this.sourceOf(instance, assumeKept);
    return parentSource ? this.index.get('I' + strip(parentSource.node.id) + ';' + segment) : undefined;
  }

  /** A nested instance copy that shows another component than the node it mirrors. */
  isSwapped(entry: Entry, assumeKept?: Entry): boolean {
    if (entry.node.type !== 'INSTANCE' || !this.isCopy(entry, assumeKept)) return false;
    const source = this.sourceOf(entry, assumeKept);
    return !!source && source.node.componentId !== entry.node.componentId;
  }

  // ── Decisions ────────────────────────────────────────────────────────────────────────────────

  /** A top-level instance (or one nested in a detached instance) that becomes a plain frame. */
  isDetached(entry: Entry): boolean {
    const known = this.decisions.get(entry);
    if (known === 'kept' || known === 'pending') return false;
    if (known === 'detached') return true;
    this.decisions.set(entry, 'pending');
    const reason = this.judge(entry);
    this.decisions.set(entry, reason ? 'detached' : 'kept');
    if (reason) this.why.set(entry, reason);
    return !!reason;
  }

  detachReason(entry: Entry) {
    return this.why.get(entry);
  }

  /** Why the instance cannot stay one, or null when it can. */
  private judge(root: Entry): 'remote' | 'missing' | 'mismatch' | null {
    const componentId = root.node.componentId;
    const component = this.index.get(componentId);
    if (!component || component.node.type !== 'COMPONENT' || component.instance) return componentId && this.remote(componentId) ? 'remote' : 'missing';
    if (this.index.children(root).length !== this.index.children(component).length) return 'mismatch';
    const stack = this.index.children(root);
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.node.id.length > L.id - 20) return 'mismatch';
      const source = this.sourceOf(entry, root);
      if (!source) return 'mismatch';
      let mirrored: Entry = source;
      if (entry.node.type === 'INSTANCE') {
        if (source.node.type !== 'INSTANCE') return 'mismatch';
        if (this.isSwapped(entry, root)) {
          const target = this.index.get(entry.node.componentId);
          if (!target || target.node.type !== 'COMPONENT' || target.instance) return this.remote(entry.node.componentId ?? '') ? 'remote' : 'missing';
          // A swap needs the mirrored node to stay an instance in the new file.
          if (this.typeOf(source) !== 'INSTANCE') return 'mismatch';
          mirrored = target;
        }
      } else if (source.node.type === 'INSTANCE' || mappedType(entry.node) !== mappedType(source.node)) return 'mismatch';
      if (this.index.children(entry).length !== this.index.children(mirrored).length) return 'mismatch';
      stack.push(...this.index.children(entry));
    }
    return null;
  }

  /** The type a Figma node has in the new file. */
  typeOf(entry: Entry): NodeType | null {
    if (entry.node.type !== 'INSTANCE') return mappedType(entry.node);
    if (this.isCopy(entry)) {
      if (this.isSwapped(entry)) return 'INSTANCE';
      const source = this.sourceOf(entry);
      return source && source !== entry ? this.typeOf(source) : 'FRAME';
    }
    return this.isDetached(entry) ? 'FRAME' : 'INSTANCE';
  }

  // ── Ids ──────────────────────────────────────────────────────────────────────────────────────

  /** The owner of a copy's id: the top-level instance, or the nearest swapped one. */
  private ownerOf(entry: Entry): Entry {
    let instance = entry.instance!;
    while (!this.isRootInstance(instance) && !this.isSwapped(instance)) instance = instance.instance!;
    return instance;
  }

  idOf(entry: Entry): NodeId {
    const known = this.ids.get(entry);
    if (known) return known;
    let id: NodeId;
    if (this.isCopy(entry)) {
      const source = this.sourceOf(entry);
      id = this.idOf(this.ownerOf(entry)) + ';' + (source ? this.idOf(source) : plainId(entry.node.id));
    } else id = plainId(entry.node.id);
    this.ids.set(entry, id);
    return id;
  }

  /** The id of the node a copy mirrors (its `mainId`), or undefined for plain nodes. */
  mainIdOf(entry: Entry): NodeId | undefined {
    if (!this.isCopy(entry)) return undefined;
    const source = this.sourceOf(entry);
    return source ? this.idOf(source) : undefined;
  }
}

/** The node a lifted component brings along: its variant set when it has one. */
export function liftUnitOf(component: Entry): Entry {
  return component.parent?.node.type === 'COMPONENT_SET' ? component.parent : component;
}
