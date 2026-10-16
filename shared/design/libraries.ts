import {z} from 'zod';
import type {
  Action,
  ComponentPropertyDefinition,
  DesignDocument,
  Hyperlink,
  ImageRef,
  NodeId,
  Paint,
  Reaction,
  RemoteAsset,
  SceneNode,
  Style,
  StyleId,
  StyleType,
  TextProps,
  Variable,
  VariableAlias,
  VariableCollection,
  VariableId,
  VariableValue,
} from './types';
import {DESIGN_SCHEMA_VERSION, LIBRARY_PAGE_ID} from './types';
import {createNode} from './defaults';
import {validateDocument} from './schema';
import type {Transaction} from './transaction';
import {applyVariablesDetailed, isAlias} from './variables';
import {updateStyleUpdates} from './styles';
import {DESIGN_FIELD_LIMITS as L} from './document-limits';

// "Morfa" shared libraries (docs/design-tool.md §Teams, "Shared libraries").
//
// A file publishes some of its components (standalone components and variant sets), styles and variable collections. The
// server stores each publication as an immutable snapshot: a small document whose one page holds the published components
// and every component they use (nested instances, instance-swap defaults), with the styles, variables and pictures all of
// them reference, plus a manifest of the published assets with a content hash and the version each last changed in.
//
// A file of the same team (or the same account's personal files) that enables the library inserts its components as
// instances of read-only copies: the copies live on the file's hidden library page (`LIBRARY_PAGE_ID`, never in `pages`)
// under ids derived from the library's (`remoteId`), each copied root carrying `remote: {libraryId, key, version}`. Styles,
// collections and variables are copied the same way and applied by reference. Because a copy's ids are the same in every
// version, an update replaces the copies and instances keep their own ids, so `syncInstances` keeps every override.
//
// Everything here is pure: the server builds snapshots and subsets with it, the editor applies imports with it.

/** The snapshot's own page: it holds the published components and what they use. */
export const SNAPSHOT_PAGE_ID = 'morfa:snapshot';
export const LIBRARY_SNAPSHOT_FORMAT = 1;
export const LIBRARY_CAPS = {
  /** Published assets of each kind in one version. */
  assets: 5_000,
  /** The change description of a publication. */
  description: 1_000,
  /** Versions a library keeps (older ones are pruned; files that use them keep their copies). */
  versionsKept: 20,
} as const;

export type LibrarySelection = {components: readonly NodeId[]; styles: readonly StyleId[]; variableCollections: readonly string[]};

export type LibraryComponentAsset = {
  key: NodeId;
  type: 'COMPONENT' | 'COMPONENT_SET';
  name: string;
  description: string;
  width: number;
  height: number;
  /** Variants of a set; 1 for a component. */
  variants: number;
  /** Content hash of the component and everything it uses. */
  hash: string;
  /** The library version this asset last changed in. */
  changedIn: number;
};
export type LibraryStyleAsset = {key: StyleId; type: StyleType; name: string; description: string; hash: string; changedIn: number};
export type LibraryCollectionAsset = {key: string; name: string; modes: number; variables: number; hash: string; changedIn: number};
export type LibraryManifest = {components: LibraryComponentAsset[]; styles: LibraryStyleAsset[]; variableCollections: LibraryCollectionAsset[]};
export type LibrarySnapshot = {format: typeof LIBRARY_SNAPSHOT_FORMAT; manifest: LibraryManifest; document: DesignDocument};

/** What the server hands an editor to use or update library assets: the part of one version's snapshot the requested assets
 *  need, its pictures already the subscriber's (copied into its scope when they were not). Ids are the library's. */
export type LibraryImport = {
  libraryId: string;
  version: number;
  /** The requested assets (keys of the manifest); dependencies come along in `document` without being listed. */
  components: NodeId[];
  styles: StyleId[];
  variableCollections: string[];
  document: DesignDocument;
};

export type LibraryErrorCode = 'empty' | 'not_local' | 'invalid';
export class LibraryError extends Error {
  constructor(readonly code: LibraryErrorCode, message: string) {
    super(message);
    this.name = 'LibraryError';
  }
}

// ── Where things are ───────────────────────────────────────────────────────────────────────────

/** True for nodes on the hidden library page: copies of library components, read-only in this file. */
export function isOnLibraryPage(doc: DesignDocument, id: NodeId): boolean {
  let node = doc.nodes[id];
  for (let guard = 0; node && guard < 10_000; guard++) {
    if (node.parentId === null) return node.id === LIBRARY_PAGE_ID;
    node = doc.nodes[node.parentId];
  }
  return false;
}

/** The copied library root (a component or a set with `remote`) a node belongs to, or null. */
export function remoteRootOf(doc: DesignDocument, id: NodeId): SceneNode | null {
  let node = doc.nodes[id];
  for (let guard = 0; node && guard < 10_000; guard++) {
    if (node.parentId === LIBRARY_PAGE_ID) return node.remote ? node : null;
    if (node.parentId === null) return null;
    node = doc.nodes[node.parentId];
  }
  return null;
}

/** The component (or set) a node id names as a library asset: a variant names its set. */
function componentRoot(doc: DesignDocument, id: NodeId): NodeId | null {
  const node = doc.nodes[id];
  if (!node) return null;
  if (node.type === 'COMPONENT_SET') return id;
  if (node.type !== 'COMPONENT') return null;
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  return parent?.type === 'COMPONENT_SET' ? parent.id : id;
}

/** Names Figma treats as private: "_Icon", ".Base" are not offered for publishing by default. */
export const isPrivateAssetName = (name: string) => /^\s*[_.]/.test(name);

export type PublishableComponent = {id: NodeId; type: 'COMPONENT' | 'COMPONENT_SET'; name: string; description: string};
export type PublishableAssets = {components: PublishableComponent[]; styles: Style[]; variableCollections: VariableCollection[]};

/** What a file can publish: its own components and variant sets (never copies of another library's), its own styles and
 *  variable collections. */
export function publishableAssets(doc: DesignDocument): PublishableAssets {
  const components: PublishableComponent[] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (node.mainId !== undefined || (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET')) continue;
    if (componentRoot(doc, id) !== id || isOnLibraryPage(doc, id)) continue;
    components.push({id, type: node.type, name: node.name, description: node.description ?? ''});
  }
  // One collator (the order of `localeCompare(…, 'en', {numeric: true})`, which builds one per call).
  const collator = new Intl.Collator('en', {numeric: true});
  const byName = <T extends {name: string}>(a: T, b: T) => collator.compare(a.name, b.name);
  return {
    components: components.sort(byName),
    styles: Object.values(doc.styles).filter(style => !style.remote).sort(byName),
    variableCollections: Object.values(doc.variableCollections).filter(collection => !collection.remote).sort(byName),
  };
}

// ── Dependencies ───────────────────────────────────────────────────────────────────────────────

export type LibraryClosure = {
  /** Components and variant sets: the selected ones first, then those they use, each once. */
  roots: NodeId[];
  /** Every node of those roots, each root before its children (children in order). */
  nodes: NodeId[];
  styles: StyleId[];
  variables: VariableId[];
  collections: string[];
  images: ImageRef[];
};

/** Everything the selected assets need in another file: the components (with nested instances' components and instance-swap
 *  defaults), the styles and variables their layers and styles reference (aliases followed), and the pictures. A published
 *  collection brings all its variables but those hidden from publishing; a collection that is only used brings the variables
 *  used. Ids that do not exist are skipped. */
export function libraryClosure(doc: DesignDocument, selection: LibrarySelection): LibraryClosure {
  const roots: NodeId[] = [];
  const rootSet = new Set<NodeId>();
  const nodes: NodeId[] = [];
  const styles = new Set<StyleId>();
  const variables = new Set<VariableId>();
  const collections = new Set<string>();
  const images = new Set<ImageRef>();
  const queue: NodeId[] = [];
  const addRoot = (id: NodeId) => {
    const root = componentRoot(doc, id);
    if (root && !rootSet.has(root)) {
      rootSet.add(root);
      roots.push(root);
      queue.push(root);
    }
  };
  const addPaints = (paints: readonly Paint[] | undefined) => {
    if (!paints) return;
    for (const paint of paints) {
      if (paint.type === 'IMAGE' && paint.imageRef) images.add(paint.imageRef);
      else if (paint.type === 'SOLID' && paint.boundVariables?.color) variables.add(paint.boundVariables.color.id);
    }
  };
  const addStyle = (id: StyleId | undefined) => {
    if (!id || styles.has(id) || !doc.styles[id]) return;
    styles.add(id);
    addPaints(doc.styles[id].paints);
  };

  for (const id of selection.components) addRoot(id);
  while (queue.length) {
    const stack = [queue.shift()!];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node) continue;
      nodes.push(node.id);
      addStyle(node.fillStyleId);
      addStyle(node.strokeStyleId);
      addStyle(node.effectStyleId);
      addStyle(node.gridStyleId);
      addStyle(node.textStyleId);
      addPaints(node.fills);
      addPaints(node.strokes);
      if (node.text) {
        for (const run of node.text.runs) {
          addStyle(run.textStyleId);
          addPaints(run.fills);
        }
      }
      if (node.boundVariables) for (const alias of Object.values(node.boundVariables)) if (alias) variables.add(alias.id);
      if (node.type === 'INSTANCE' && node.componentId) addRoot(node.componentId);
      if (node.componentPropertyDefinitions) {
        for (const def of Object.values(node.componentPropertyDefinitions)) if (def.type === 'INSTANCE_SWAP' && typeof def.defaultValue === 'string') addRoot(def.defaultValue);
      }
      const children = node.children;
      if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  for (const id of selection.styles) addStyle(id);
  for (const id of selection.variableCollections) {
    const collection = doc.variableCollections[id];
    if (!collection) continue;
    collections.add(id);
    for (const variableId of collection.variableIds) if (doc.variables[variableId] && !doc.variables[variableId].hiddenFromPublishing) variables.add(variableId);
  }
  // Aliases: a variable that takes another's value needs that one too.
  const pending = [...variables];
  while (pending.length) {
    const variable = doc.variables[pending.pop()!];
    if (!variable) continue;
    for (const value of Object.values(variable.valuesByMode)) {
      if (isAlias(value) && doc.variables[value.id] && !variables.has(value.id)) {
        variables.add(value.id);
        pending.push(value.id);
      }
    }
  }
  const presentVariables = [...variables].filter(id => doc.variables[id] && doc.variableCollections[doc.variables[id].collectionId]);
  for (const id of presentVariables) collections.add(doc.variables[id].collectionId);
  return {roots, nodes, styles: [...styles], variables: presentVariables, collections: [...collections], images: [...images]};
}

// ── Snapshots ──────────────────────────────────────────────────────────────────────────────────

const withoutRemote = <T extends {remote?: RemoteAsset}>(value: T): T => {
  if (value.remote === undefined) return value;
  const copy = {...value};
  delete copy.remote;
  return copy;
};

/** The part of `doc` a closure names, as a document of its own: one page holding the roots (placed at 0,0: where a component
 *  stood in its file is not part of it), the styles, the collections with only the variables taken, the pictures and the
 *  variable modes of the nodes taken. Copies' `remote` marks are dropped: the snapshot speaks for its own library. */
function closureDocument(doc: DesignDocument, closure: LibraryClosure): DesignDocument {
  const roots = new Set(closure.roots);
  const nodes: DesignDocument['nodes'] = {
    [SNAPSHOT_PAGE_ID]: createNode('PAGE', {id: SNAPSHOT_PAGE_ID, name: 'Library', parentId: null, children: [...closure.roots]}),
  };
  for (const id of closure.nodes) {
    const node = doc.nodes[id];
    nodes[id] = roots.has(id) ? withoutRemote({...node, parentId: SNAPSHOT_PAGE_ID, x: 0, y: 0}) : node;
  }
  const variables: DesignDocument['variables'] = {};
  for (const id of closure.variables) variables[id] = withoutRemote(doc.variables[id]);
  const variableCollections: DesignDocument['variableCollections'] = {};
  for (const id of closure.collections) {
    const collection = doc.variableCollections[id];
    if (collection) variableCollections[id] = withoutRemote({...collection, variableIds: collection.variableIds.filter(each => each in variables)});
  }
  const styles: DesignDocument['styles'] = {};
  for (const id of closure.styles) styles[id] = withoutRemote(doc.styles[id]);
  const images: DesignDocument['images'] = {};
  for (const ref of closure.images) if (doc.images[ref]) images[ref] = doc.images[ref];
  const out: DesignDocument = {schemaVersion: DESIGN_SCHEMA_VERSION, pages: [SNAPSHOT_PAGE_ID], nodes, styles, images, variableCollections, variables};
  const modes: Record<NodeId, Record<string, string>> = {};
  for (const id of closure.nodes) {
    const choice = doc.variableModes?.[id];
    if (!choice) continue;
    const kept = Object.fromEntries(Object.entries(choice).filter(([collectionId]) => collectionId in variableCollections));
    if (Object.keys(kept).length) modes[id] = kept;
  }
  if (Object.keys(modes).length) out.variableModes = modes;
  return out;
}

/** JSON with object keys sorted, so equal content always reads the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
}

/** A 64-bit hash of a text (two mixed 32-bit lanes) as 16 hex digits. Not cryptographic: it tells versions apart. */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** The hash of one asset with everything it uses, read from a snapshot document. */
function assetHash(snapshot: DesignDocument, selection: LibrarySelection): string {
  const closure = libraryClosure(snapshot, selection);
  const part = closureDocument(snapshot, closure);
  return contentHash(canonicalJson({nodes: closure.nodes.map(id => part.nodes[id]), styles: part.styles, variables: part.variables, collections: part.variableCollections, images: part.images, modes: part.variableModes ?? {}}));
}

const NONE: LibrarySelection = {components: [], styles: [], variableCollections: []};

/**
 * A publication of `doc`: the selected local components, styles and collections with everything they use, as a snapshot
 * document, and the manifest of what was published. `previous` (the last version's manifest) keeps the version each unchanged
 * asset last changed in, so files that use the library are offered only real updates. Copies of other libraries' components
 * are never published themselves, only carried along when a published component uses them.
 */
export function buildLibrarySnapshot(doc: DesignDocument, selection: LibrarySelection, options: {version: number; previous?: LibraryManifest | null}): LibrarySnapshot {
  const components: NodeId[] = [];
  for (const id of selection.components) {
    const root = componentRoot(doc, id);
    if (!root) continue;
    if (isOnLibraryPage(doc, root)) throw new LibraryError('not_local', 'Components from other libraries are not published.');
    if (!components.includes(root)) components.push(root);
  }
  const styles: StyleId[] = [];
  for (const id of selection.styles) {
    const style = doc.styles[id];
    if (!style) continue;
    if (style.remote) throw new LibraryError('not_local', 'Styles from other libraries are not published.');
    if (!styles.includes(id)) styles.push(id);
  }
  const collections: string[] = [];
  for (const id of selection.variableCollections) {
    const collection = doc.variableCollections[id];
    if (!collection) continue;
    if (collection.remote) throw new LibraryError('not_local', 'Variables from other libraries are not published.');
    if (!collections.includes(id)) collections.push(id);
  }
  if (!components.length && !styles.length && !collections.length) throw new LibraryError('empty', 'Choose what to publish.');
  if (components.length > LIBRARY_CAPS.assets || styles.length > LIBRARY_CAPS.assets || collections.length > LIBRARY_CAPS.assets)
    throw new LibraryError('invalid', `No more than ${LIBRARY_CAPS.assets} assets of each kind.`);

  const document = closureDocument(doc, libraryClosure(doc, {components, styles, variableCollections: collections}));
  const previous = options.previous;
  const changedIn = (list: readonly {key: string; hash: string; changedIn: number}[] | undefined, key: string, hash: string) => {
    const before = list?.find(entry => entry.key === key);
    return before && before.hash === hash ? before.changedIn : options.version;
  };
  const manifest: LibraryManifest = {
    components: components.map(key => {
      const node = document.nodes[key];
      const hash = assetHash(document, {...NONE, components: [key]});
      const variants = node.type === 'COMPONENT_SET' ? (node.children ?? []).filter(id => document.nodes[id]?.type === 'COMPONENT').length : 1;
      return {key, type: node.type as 'COMPONENT' | 'COMPONENT_SET', name: node.name, description: node.description ?? '', width: node.width, height: node.height, variants, hash, changedIn: changedIn(previous?.components, key, hash)};
    }),
    styles: styles.map(key => {
      const style = document.styles[key];
      const hash = assetHash(document, {...NONE, styles: [key]});
      return {key, type: style.type, name: style.name, description: style.description, hash, changedIn: changedIn(previous?.styles, key, hash)};
    }),
    variableCollections: collections.map(key => {
      const collection = document.variableCollections[key];
      const hash = assetHash(document, {...NONE, variableCollections: [key]});
      return {key, name: collection.name, modes: collection.modes.length, variables: collection.variableIds.length, hash, changedIn: changedIn(previous?.variableCollections, key, hash)};
    }),
  };
  return {format: LIBRARY_SNAPSHOT_FORMAT, manifest, document};
}

/** The keys of a manifest by kind. */
export const manifestKeys = (manifest: LibraryManifest): LibrarySelection => ({
  components: manifest.components.map(entry => entry.key),
  styles: manifest.styles.map(entry => entry.key),
  variableCollections: manifest.variableCollections.map(entry => entry.key),
});

/** The part of a snapshot the requested assets need (unknown keys are ignored): what the server sends an editor, before its
 *  pictures are made the subscriber's. */
export function snapshotPart(snapshot: LibrarySnapshot, request: LibrarySelection): {selection: LibrarySelection; document: DesignDocument} {
  const pick = <T extends {key: string}>(list: readonly T[], wanted: readonly string[]) => {
    const keys = new Set(list.map(entry => entry.key));
    return [...new Set(wanted)].filter(key => keys.has(key));
  };
  const selection: LibrarySelection = {
    components: pick(snapshot.manifest.components, request.components),
    styles: pick(snapshot.manifest.styles, request.styles),
    variableCollections: pick(snapshot.manifest.variableCollections, request.variableCollections),
  };
  return {selection, document: closureDocument(snapshot.document, libraryClosure(snapshot.document, selection))};
}

// ── Validation ─────────────────────────────────────────────────────────────────────────────────

const assetKey = z.string().min(1).max(L.id);
const hash = z.string().regex(/^[0-9a-f]{16}$/);
const version = z.number().int().min(1).max(1_000_000_000);
const manifestSchema = z.object({
  components: z
    .array(z.object({
      key: assetKey,
      type: z.enum(['COMPONENT', 'COMPONENT_SET']),
      name: z.string().max(L.name),
      description: z.string().max(L.description),
      width: z.number().finite().min(0),
      height: z.number().finite().min(0),
      variants: z.number().int().min(0).max(100_000),
      hash,
      changedIn: version,
    }))
    .max(LIBRARY_CAPS.assets),
  styles: z
    .array(z.object({key: assetKey, type: z.enum(['FILL', 'TEXT', 'EFFECT', 'GRID']), name: z.string().max(L.name), description: z.string().max(L.description), hash, changedIn: version}))
    .max(LIBRARY_CAPS.assets),
  variableCollections: z
    .array(z.object({key: assetKey, name: z.string().max(L.name), modes: z.number().int().min(0).max(L.modes), variables: z.number().int().min(0).max(L.variables), hash, changedIn: version}))
    .max(LIBRARY_CAPS.assets),
});

export type LibraryValidation<T> = {ok: true; value: T} | {ok: false; error: string; path: string};

/** A snapshot-shaped document: valid as a document (shared/design/schema.ts), its one page holding only components and sets,
 *  nothing in it marked as another library's copy. */
function checkPartDocument(value: unknown): LibraryValidation<DesignDocument> {
  const result = validateDocument(value);
  if (!result.ok) return {ok: false, error: result.error, path: 'document.' + result.path};
  const doc = result.value;
  if (doc.pages.length !== 1 || doc.pages[0] !== SNAPSHOT_PAGE_ID) return {ok: false, error: 'A library has one page.', path: 'document.pages'};
  for (const id of doc.nodes[SNAPSHOT_PAGE_ID].children ?? []) {
    const type = doc.nodes[id]?.type;
    if (type !== 'COMPONENT' && type !== 'COMPONENT_SET') return {ok: false, error: 'A library contains only components.', path: 'document.nodes.' + id};
  }
  for (const [table, map] of [['styles', doc.styles], ['variableCollections', doc.variableCollections], ['variables', doc.variables]] as const)
    for (const [key, entry] of Object.entries(map as Record<string, {remote?: RemoteAsset}>))
      if (entry.remote) return {ok: false, error: 'A copy from another library.', path: `document.${table}.${key}.remote`};
  return {ok: true, value: doc};
}

/** A stored or received snapshot: the manifest's shape and bounds, the document's, and every published key present in it. */
export function validateLibrarySnapshot(value: unknown): LibraryValidation<LibrarySnapshot> {
  if (typeof value !== 'object' || value === null || (value as {format?: unknown}).format !== LIBRARY_SNAPSHOT_FORMAT) return {ok: false, error: 'Unknown library format.', path: 'format'};
  const raw = value as {manifest?: unknown; document?: unknown};
  const manifest = manifestSchema.safeParse(raw.manifest);
  if (!manifest.success) return {ok: false, error: 'The library\'s asset list is damaged.', path: 'manifest.' + (manifest.error.issues[0]?.path.join('.') ?? '')};
  const document = checkPartDocument(raw.document);
  if (!document.ok) return document;
  const doc = document.value;
  const roots = new Set(doc.nodes[SNAPSHOT_PAGE_ID].children ?? []);
  for (const entry of manifest.data.components) if (!roots.has(entry.key)) return {ok: false, error: 'The published component is not in the library.', path: 'manifest.components'};
  for (const entry of manifest.data.styles) if (!doc.styles[entry.key]) return {ok: false, error: 'The published style is not in the library.', path: 'manifest.styles'};
  for (const entry of manifest.data.variableCollections) if (!doc.variableCollections[entry.key]) return {ok: false, error: 'The published collection is not in the library.', path: 'manifest.variableCollections'};
  return {ok: true, value: {format: LIBRARY_SNAPSHOT_FORMAT, manifest: manifest.data as LibraryManifest, document: doc}};
}

const keyList = z.array(assetKey).max(LIBRARY_CAPS.assets);
const importSchema = z.object({
  libraryId: z.string().regex(/^[0-9a-f-]{36}$/),
  version,
  components: keyList,
  styles: keyList,
  variableCollections: keyList,
});

/** What an editor checks before an import touches its document: the payload's shape and its document as a snapshot part. */
export function validateLibraryImport(value: unknown): LibraryValidation<LibraryImport> {
  const head = importSchema.safeParse(value);
  if (!head.success) return {ok: false, error: 'The library response is damaged.', path: head.error.issues[0]?.path.join('.') ?? ''};
  const document = checkPartDocument((value as {document?: unknown}).document);
  if (!document.ok) return document;
  return {ok: true, value: {...head.data, document: document.value}};
}

// ── Using a library ────────────────────────────────────────────────────────────────────────────

/** The prefix of a library's ids in the files that use it: short, fixed for the library and impossible for an ordinary id. */
export const remotePrefix = (libraryId: string) => 'r' + libraryId.replace(/-/g, '').slice(0, 16) + ':';

/** The id a library's node, style, collection or variable has in a file that uses it. Instance copies' ids
 *  (`${instance};${main}`) are mapped part by part, so a copy keeps naming its instance and the node it mirrors. */
export function remoteId(libraryId: string, id: string): string {
  const prefix = remotePrefix(libraryId);
  return id.includes(';') ? id.split(';').map(part => prefix + part).join(';') : prefix + id;
}

export type LibraryImportResult = {
  /** The local ids of the copied components and sets (requested and their dependencies). */
  components: NodeId[];
  styles: StyleId[];
  collections: string[];
  variables: VariableId[];
};

/**
 * Puts an import into a transaction: the hidden library page (when missing), the collections and variables, the styles, the
 * pictures and the components, each under its `remoteId` with `remote: {libraryId, key, version}`. A component already
 * copied is replaced whole under the same ids, so instances of it follow on commit and keep their overrides; a style or
 * variable already copied takes its new value and the layers using it follow. A collection only carried along by a
 * dependency keeps the version it had (its other variables were not updated). `payload` must have passed
 * `validateLibraryImport`.
 */
export function applyLibraryImport(tx: Transaction, payload: LibraryImport): LibraryImportResult {
  const {libraryId, version, document: part} = payload;
  const R = (id: string) => remoteId(libraryId, id);
  const meta = (key: string): RemoteAsset => ({libraryId, key, version});
  const requestedCollections = new Set(payload.variableCollections);
  const before = tx.doc;
  const result: LibraryImportResult = {components: [], styles: [], collections: [], variables: []};

  const mapAlias = (alias: VariableAlias): VariableAlias => ({type: 'VARIABLE_ALIAS', id: R(alias.id)});
  const mapValue = (value: VariableValue): VariableValue => (isAlias(value) ? mapAlias(value) : value);
  const mapPaints = (paints: Paint[]): Paint[] =>
    paints.map(paint => (paint.type === 'SOLID' && paint.boundVariables?.color ? {...paint, boundVariables: {color: mapAlias(paint.boundVariables.color)}} : paint));
  const mapStyle = (id: StyleId | undefined) => (id && part.styles[id] ? R(id) : undefined);
  const isPartComponent = (id: unknown): id is NodeId => typeof id === 'string' && (part.nodes[id]?.type === 'COMPONENT' || part.nodes[id]?.type === 'COMPONENT_SET');
  const mapLink = (link: Hyperlink | null | undefined): Hyperlink | null | undefined => {
    if (!link || link.type !== 'NODE') return link;
    return part.nodes[link.nodeId] ? {type: 'NODE', nodeId: R(link.nodeId)} : null;
  };
  const mapText = (text: TextProps): TextProps => ({
    ...text,
    style: text.style.hyperlink?.type === 'NODE' ? {...text.style, hyperlink: mapLink(text.style.hyperlink)} : text.style,
    runs: text.runs.map(run => {
      const next = {...run};
      if (run.textStyleId) {
        const mapped = mapStyle(run.textStyleId);
        if (mapped) next.textStyleId = mapped;
        else delete next.textStyleId;
      }
      if (run.fills) next.fills = mapPaints(run.fills);
      if (run.style.hyperlink?.type === 'NODE') next.style = {...run.style, hyperlink: mapLink(run.style.hyperlink)};
      return next;
    }),
  });
  const mapReactions = (reactions: Reaction[]): Reaction[] =>
    reactions
      .map(reaction => ({
        ...reaction,
        actions: reaction.actions
          .filter(action => action.type !== 'NODE' || !!part.nodes[action.destinationId])
          .map((action): Action => (action.type === 'NODE' ? {...action, destinationId: R(action.destinationId)} : action)),
      }))
      .filter(reaction => reaction.actions.length > 0);
  const mapDefinitions = (defs: Record<string, ComponentPropertyDefinition>) =>
    Object.fromEntries(Object.entries(defs).map(([key, def]) => {
      if (def.type !== 'INSTANCE_SWAP') return [key, def];
      const next: ComponentPropertyDefinition = {...def, defaultValue: isPartComponent(def.defaultValue) ? R(def.defaultValue) : def.defaultValue};
      if (def.preferredValues) next.preferredValues = def.preferredValues.filter(isPartComponent).map(R);
      return [key, next];
    }));
  const STYLE_FIELDS = ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'textStyleId'] as const;
  const mapNode = (node: SceneNode, root: boolean): SceneNode => {
    const out: SceneNode = {...node, id: R(node.id), parentId: root ? LIBRARY_PAGE_ID : R(node.parentId!)};
    delete out.children;
    if (node.mainId !== undefined) out.mainId = R(node.mainId);
    if (node.componentId !== undefined) out.componentId = R(node.componentId);
    for (const field of STYLE_FIELDS) {
      if (!node[field]) continue;
      const mapped = mapStyle(node[field]);
      if (mapped) out[field] = mapped;
      else delete out[field];
    }
    out.fills = mapPaints(node.fills);
    out.strokes = mapPaints(node.strokes);
    if (node.boundVariables) out.boundVariables = Object.fromEntries(Object.entries(node.boundVariables).map(([field, alias]) => [field, mapAlias(alias)]));
    if (node.text) out.text = mapText(node.text);
    if (node.componentPropertyDefinitions) out.componentPropertyDefinitions = mapDefinitions(node.componentPropertyDefinitions);
    if (node.componentProperties) out.componentProperties = Object.fromEntries(Object.entries(node.componentProperties).map(([key, value]) => [key, isPartComponent(value) ? R(value) : value]));
    if (node.reactions.length) out.reactions = mapReactions(node.reactions);
    if (root) out.remote = meta(node.id);
    else delete out.remote;
    return out;
  };

  // Collections and variables first: layers bind them.
  const changedVariables: VariableId[] = [];
  for (const [id, collection] of Object.entries(part.variableCollections)) {
    const local = R(id);
    const existing = tx.doc.variableCollections[local];
    const ids = collection.variableIds.map(R);
    const kept = existing ? existing.variableIds.filter(each => !ids.includes(each)) : [];
    const remote = existing?.remote && !requestedCollections.has(id) ? existing.remote : meta(id);
    tx.setVariableCollection({...collection, id: local, variableIds: [...ids, ...kept], remote});
    result.collections.push(local);
  }
  for (const [id, variable] of Object.entries(part.variables)) {
    const local = R(id);
    const next: Variable = {
      ...variable,
      id: local,
      collectionId: R(variable.collectionId),
      valuesByMode: Object.fromEntries(Object.entries(variable.valuesByMode).map(([mode, value]) => [mode, mapValue(value)])),
      remote: meta(id),
    };
    const existing = before.variables[local];
    if (existing && canonicalJson({...existing, remote: undefined}) !== canonicalJson({...next, remote: undefined})) changedVariables.push(local);
    tx.setVariable(next);
    result.variables.push(local);
  }
  // Styles.
  const changedStyles: Style[] = [];
  for (const [id, style] of Object.entries(part.styles)) {
    const local = R(id);
    const next: Style = {...style, id: local, remote: meta(id)};
    if (style.paints) next.paints = mapPaints(style.paints);
    const existing = before.styles[local];
    if (existing && canonicalJson({...existing, remote: undefined}) !== canonicalJson({...next, remote: undefined})) changedStyles.push(next);
    tx.setStyle(next);
    result.styles.push(local);
  }
  // Pictures, already the subscriber's.
  for (const [ref, asset] of Object.entries(part.images)) {
    const current = tx.doc.images[ref];
    if (!current || current.url !== asset.url || current.width !== asset.width || current.height !== asset.height) tx.setImage(ref, asset);
  }
  // Components: each root replaced whole under the same ids, parents before children, children in order.
  const page = part.nodes[SNAPSHOT_PAGE_ID];
  if (page?.children?.length) tx.addLibraryPage();
  for (const rootId of page?.children ?? []) {
    const local = R(rootId);
    if (tx.get(local)) tx.remove(local);
    const stack: [NodeId, NodeId][] = [[rootId, LIBRARY_PAGE_ID]];
    while (stack.length) {
      const [id, parentId] = stack.pop()!;
      const node = part.nodes[id];
      if (!node) continue;
      tx.create(mapNode(node, parentId === LIBRARY_PAGE_ID), parentId);
      const children = node.children;
      if (children) for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], R(id)]);
    }
    result.components.push(local);
  }
  for (const [nodeId, choice] of Object.entries(part.variableModes ?? {})) {
    if (!part.nodes[nodeId]) continue;
    tx.setVariableModes(R(nodeId), Object.fromEntries(Object.entries(choice).map(([collectionId, modeId]) => [R(collectionId), modeId])));
  }

  // Layers elsewhere in the file that use an updated style or variable follow it.
  for (const style of changedStyles) for (const [id, patch] of updateStyleUpdates(tx.doc, style)) if (tx.get(id)) tx.update(id, patch);
  if (changedVariables.length) {
    const current = tx.doc;
    const applied = applyVariablesDetailed(current, new Set(changedVariables));
    for (const id of applied.changed) {
      const now = applied.doc.nodes[id], was = current.nodes[id];
      if (!now || !was || now === was) continue;
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(now)) if (key !== 'id' && key !== 'parentId' && key !== 'children' && (was as unknown as Record<string, unknown>)[key] !== value) fields[key] = value;
      if (Object.keys(fields).length) tx.update(id, fields as Partial<SceneNode>);
    }
  }
  return result;
}

// ── Updates ────────────────────────────────────────────────────────────────────────────────────

export type LibraryState = {id: string; version: number; manifest: LibraryManifest};
export type LibraryUpdate = {
  libraryId: string;
  kind: 'component' | 'style' | 'variables';
  /** The asset's key in the library and its id in this file. */
  key: string;
  localId: string;
  name: string;
  /** The version this file has and the one offered. */
  from: number;
  to: number;
};

/** The library assets this file holds copies of, by library: what "Update all" asks for. */
export function remoteAssets(doc: DesignDocument): Map<string, {components: NodeId[]; styles: StyleId[]; variableCollections: string[]}> {
  const out = new Map<string, {components: NodeId[]; styles: StyleId[]; variableCollections: string[]}>();
  const entry = (libraryId: string) => {
    let value = out.get(libraryId);
    if (!value) out.set(libraryId, (value = {components: [], styles: [], variableCollections: []}));
    return value;
  };
  for (const id of doc.nodes[LIBRARY_PAGE_ID]?.children ?? []) {
    const remote = doc.nodes[id]?.remote;
    if (remote) entry(remote.libraryId).components.push(remote.key);
  }
  for (const style of Object.values(doc.styles)) if (style.remote) entry(style.remote.libraryId).styles.push(style.remote.key);
  for (const collection of Object.values(doc.variableCollections)) if (collection.remote) entry(collection.remote.libraryId).variableCollections.push(collection.remote.key);
  return out;
}

/** Library assets this file holds older copies of than the libraries now publish: a copy is out of date when the asset changed
 *  in a later version than the copy's. Components only carried along (not published themselves) follow the ones that use them. */
export function libraryUpdates(doc: DesignDocument, libraries: readonly LibraryState[]): LibraryUpdate[] {
  const byId = new Map(libraries.map(library => [library.id, library]));
  const updates: LibraryUpdate[] = [];
  const check = (kind: LibraryUpdate['kind'], remote: RemoteAsset | undefined, localId: string, fallbackName: string) => {
    if (!remote) return;
    const library = byId.get(remote.libraryId);
    if (!library) return;
    const list = kind === 'component' ? library.manifest.components : kind === 'style' ? library.manifest.styles : library.manifest.variableCollections;
    const entry = (list as readonly {key: string; name: string; changedIn: number}[]).find(each => each.key === remote.key);
    if (entry && entry.changedIn > remote.version) updates.push({libraryId: library.id, kind, key: remote.key, localId, name: entry.name || fallbackName, from: remote.version, to: library.version});
  };
  for (const id of doc.nodes[LIBRARY_PAGE_ID]?.children ?? []) {
    const node = doc.nodes[id];
    if (node) check('component', node.remote, id, node.name);
  }
  for (const style of Object.values(doc.styles)) check('style', style.remote, style.id, style.name);
  for (const collection of Object.values(doc.variableCollections)) check('variables', collection.remote, collection.id, collection.name);
  return updates;
}
