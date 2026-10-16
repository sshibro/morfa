// The documents the demo files hold: a handful of small but valid design documents (pages of frames with shapes), boards and one
// library file, built with the product's own factories (shared/design/defaults.ts) and checked with its own validators before anything
// is written, so the editor opens every demo file. Node ids come from the seeder's PRNG, not newId(), to stay deterministic.
import {createDocument, createNode, solid} from '../../../shared/design/defaults';
import {createBoardDocument} from '../../../shared/design/board/document';
import {buildLibrarySnapshot, validateLibrarySnapshot} from '../../../shared/design/libraries';
import {validateDocument} from '../../../shared/design/schema';
import type {DesignDocument, NodeId, NodeType, RGB} from '../../../shared/design/types';
import type {Random} from './random';

export type DemoDocument = {
  text: string;
  /** Bytes of the JSON text (design_files.bytes). */
  bytes: number;
  /** Object.keys(nodes).length, what design_files.node_count stores. */
  nodeCount: number;
  pageId: NodeId;
  /** Layers a comment pin or a vote may name. */
  layerIds: NodeId[];
};
export type DemoLibrary = {document: DemoDocument; manifest: string; snapshot: string; bytes: number};

const PALETTE: readonly RGB[] = [
  {r: 0.96, g: 0.42, b: 0.31},
  {r: 0.2, g: 0.45, b: 0.95},
  {r: 0.12, g: 0.75, b: 0.55},
  {r: 0.99, g: 0.8, b: 0.2},
  {r: 0.55, g: 0.35, b: 0.85},
  {r: 0.13, g: 0.13, b: 0.15},
  {r: 0.93, g: 0.93, b: 0.95},
];
const FRAME_NAMES = [
  'Home',
  'Catalog',
  'Card',
  'Cart',
  'Profile',
  'Sign in',
  'Onboarding 1',
  'Onboarding 2',
  'Settings',
];
const SHAPE_NAMES = ['Background', 'Button', 'Card', 'Avatar', 'Banner', 'Badge', 'Divider', 'Illustration'];

const nodeId = (rng: Random) => rng.base36(10);

function finish(doc: DesignDocument, layerIds: NodeId[]): DemoDocument {
  const text = JSON.stringify(doc);
  const checked = validateDocument(JSON.parse(text));
  if (!checked.ok) throw Error(`A demo document is invalid at ${checked.path}: ${checked.error}`);
  return {
    text,
    bytes: Buffer.byteLength(text),
    nodeCount: Object.keys(doc.nodes).length,
    pageId: doc.pages[0],
    layerIds,
  };
}

/** Adds `type` under `parent` (its children are listed bottom-to-top). */
function add(doc: DesignDocument, parent: NodeId, type: NodeType, props: Parameters<typeof createNode>[1]): NodeId {
  doc.nodes[props.id] = createNode(type, {...props, parentId: parent});
  doc.nodes[parent].children!.push(props.id);
  return props.id;
}

/** A design file: one page of `frames` screens, each with a few shapes. Mobile or desktop sized. */
function designDocument(rng: Random, frames: number, shapes: number): DemoDocument {
  const page = nodeId(rng),
    doc = createDocument(page);
  const mobile = rng.chance(0.5),
    width = mobile ? 375 : 1440,
    height = mobile ? 812 : 900;
  const layers: NodeId[] = [];
  for (let f = 0; f < frames; f++) {
    const frame = add(doc, page, 'FRAME', {
      id: nodeId(rng),
      name: FRAME_NAMES[f % FRAME_NAMES.length],
      x: f * (width + 120),
      y: 0,
      width,
      height,
    });
    layers.push(frame);
    for (let s = 0; s < shapes; s++) {
      const type: NodeType = rng.chance(0.75) ? 'RECTANGLE' : 'ELLIPSE';
      const w = Math.round(rng.uniform(0.15, 0.9) * width),
        h = Math.round(rng.uniform(40, 260));
      const id = add(doc, frame, type, {
        id: nodeId(rng),
        name: rng.pick(SHAPE_NAMES),
        x: Math.round(rng.uniform(0, width - w)),
        y: Math.round(rng.uniform(0, height - h)),
        width: w,
        height: h,
        fills: [solid(rng.pick(PALETTE))],
        ...(type === 'RECTANGLE' ? {cornerRadius: rng.pick([0, 4, 8, 12, 16])} : {}),
      });
      layers.push(id);
    }
  }
  return finish(doc, layers);
}

/** A board ("Board"): sections with sticky-coloured cards on one page. */
function boardDocument(rng: Random, sections: number): DemoDocument {
  const page = nodeId(rng),
    doc = createBoardDocument(page);
  const layers: NodeId[] = [];
  for (let s = 0; s < sections; s++) {
    const section = add(doc, page, 'SECTION', {
      id: nodeId(rng),
      name: ['Ideas', 'Problems', 'Solutions', 'Questions'][s % 4],
      x: s * 760,
      y: 0,
      width: 700,
      height: 900,
    });
    const cards = rng.int(3, 8);
    for (let c = 0; c < cards; c++) {
      const id = add(doc, section, 'RECTANGLE', {
        id: nodeId(rng),
        name: 'Sticky',
        x: 40 + (c % 3) * 210,
        y: 60 + Math.floor(c / 3) * 220,
        width: 180,
        height: 180,
        fills: [solid(rng.pick(PALETTE.slice(0, 5)))],
      });
      layers.push(id);
    }
  }
  return finish(doc, layers);
}

/** A library file: a page with a few components, and its first publication (manifest and snapshot as the server stores them). */
function libraryDocument(rng: Random): DemoLibrary {
  const page = nodeId(rng),
    doc = createDocument(page);
  const components: NodeId[] = [];
  for (const [i, name] of ['Button', 'Input', 'Card', 'Badge'].entries()) {
    const component = add(doc, page, 'COMPONENT', {id: nodeId(rng), name, x: i * 260, y: 0, width: 220, height: 64});
    add(doc, component, 'RECTANGLE', {
      id: nodeId(rng),
      name: 'Background',
      width: 220,
      height: 64,
      cornerRadius: 12,
      fills: [solid(PALETTE[i % PALETTE.length])],
    });
    components.push(component);
  }
  const document = finish(doc, components);
  const snapshot = buildLibrarySnapshot(
    JSON.parse(document.text) as DesignDocument,
    {components, styles: [], variableCollections: []},
    {version: 1},
  );
  const checked = validateLibrarySnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (!checked.ok) throw Error(`The demo library is invalid at ${checked.path}: ${checked.error}`);
  const snapshotText = JSON.stringify(checked.value),
    manifestText = JSON.stringify(checked.value.manifest);
  return {
    document,
    snapshot: snapshotText,
    manifest: manifestText,
    bytes: Buffer.byteLength(snapshotText) + Buffer.byteLength(manifestText),
  };
}

export type DocumentKit = {designs: DemoDocument[]; boards: DemoDocument[]; library: DemoLibrary};

/** Every document the demo files pick from. */
export function documentKit(rng: Random): DocumentKit {
  const designs: DemoDocument[] = [];
  for (const [frames, shapes] of [
    [1, 2],
    [1, 4],
    [2, 3],
    [2, 5],
    [3, 4],
    [3, 6],
    [4, 4],
    [5, 5],
    [6, 5],
    [2, 8],
  ] as const)
    designs.push(designDocument(rng, frames, shapes));
  const boards = [1, 2, 3, 4].map(sections => boardDocument(rng, sections));
  return {designs, boards, library: libraryDocument(rng)};
}
