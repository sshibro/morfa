// The open of a big file from its checkpoint: the store's nodes come from a
// `MorfaDoc.decode_from(bytes)` in parts (crates/wasm src/parts.rs `part_json`), each a JSON string of about 2 000
// nodes, never the file's whole text. A shared part writes each heavy value once (`values`) and names it from the nodes
// by its index (none of those fields is ever a number): `readPart` puts the one parsed object back in each, so equal
// fills, strokes, effects, constraints and text of a part are one object (a smaller heap, and identity-keyed caches
// that hit). Treat them as the store treats every node value: never written in place.
import type {FontSpec} from './text-layout';
import type {DesignDocument, NodeId, SceneNode} from './types';

/** What `MorfaDoc.part_json` writes. */
export type NodePart = {nodes: Record<NodeId, SceneNode>; values?: unknown[]};

/** The fields a shared part writes as references (crates/wasm src/parts.rs `HEAVY`). */
export const PART_SHARED_FIELDS = ['fills', 'strokes', 'effects', 'constraints', 'text'] as const;

/** Nodes per part by default: about 0.6 MB of JSON. A loader can pick its own count (lane O sizes parts to a time
 *  budget per slice, measured on the first parts). */
export const PART_NODES = 1000;

/** The entries of a decoded document this module reads (shared/design/engine-switch.ts `MorfaDocHandle`). */
export interface PartSource {
  /** One past the highest node slot: parts cover `[start, start + count)` of them. */
  part_slots(): number;
  part_json(start: number, count: number, shared: boolean): string;
  /** export-raster.ts `fontSpecsUnder(doc, root)` (every page's when `root` is absent) as JSON. */
  font_specs(root?: string): string;
  /** The document as `to_json()` writes it, with `"nodes": {}`. */
  tables_json(): string;
}

/** The nodes of one part, every reference replaced by its value. */
export function readPart(json: string): Record<NodeId, SceneNode> {
  const part = JSON.parse(json) as NodePart;
  const values = part.values;
  if (!values) return part.nodes;
  for (const id in part.nodes) {
    const node = part.nodes[id] as unknown as Record<string, unknown>;
    for (const key of PART_SHARED_FIELDS) {
      const ref = node[key];
      if (typeof ref === 'number') node[key] = values[ref];
    }
  }
  return part.nodes;
}

/** Every part of `source` in order, `count` slots each. */
export function* partsOf(
  source: PartSource,
  options: {shared?: boolean; count?: number} = {},
): Generator<Record<NodeId, SceneNode>> {
  const count = options.count ?? PART_NODES;
  const slots = source.part_slots();
  for (let start = 0; start < slots; start += count)
    yield readPart(source.part_json(start, count, options.shared ?? true));
}

/** The whole document: the tables and every part's nodes. */
export function documentOf(source: PartSource, options: {shared?: boolean; count?: number} = {}): DesignDocument {
  const nodes: Record<NodeId, SceneNode> = {};
  for (const part of partsOf(source, options)) Object.assign(nodes, part);
  return {...(JSON.parse(source.tables_json()) as DesignDocument), nodes};
}

/** The faces the text under `root` (every page when absent) sets type in. */
export const fontSpecsOf = (source: PartSource, root?: NodeId): FontSpec[] =>
  JSON.parse(source.font_specs(root)) as FontSpec[];
