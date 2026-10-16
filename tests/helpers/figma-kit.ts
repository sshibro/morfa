import type {FigmaFile, FigmaNode} from '../../shared/design/figma-import';

// A generated Figma UI kit in the REST API's shape (GET /v1/files/:key?geometry=paths), shaped like Nuxt UI v4:
// a page per component, each with one component set of many variants and documentation
// frames of instances of them; picture fills on a cover. Nothing is downloaded and no customer file is in the repository: the size of
// every part is a parameter, so tests push each limit on its own.

export type KitShape = {
  /** Component pages («Button», «Input»…). */
  pages: number;
  /** Variants in each page's component set (color × variant × size × state in a real kit). */
  variants: number;
  /** Layers inside one variant (its frame, icon, label…), at least 2. */
  layersPerVariant: number;
  /** Documentation frames on each page, each showing `instancesPerFrame` instances of the page's variants. */
  docFrames: number;
  instancesPerFrame: number;
  /** Picture fills on a «Cover» page (distinct image refs). */
  pictures: number;
  /** Extra characters in every layer's name: a kit's long, descriptive names make its JSON larger per layer. */
  nameBytes?: number;
  /** Each page's examples show the previous page's variants (a page that needs components from another one). */
  borrow?: boolean;
};

export const NUXT_LIKE: KitShape = {pages: 60, variants: 120, layersPerVariant: 6, docFrames: 4, instancesPerFrame: 20, pictures: 12};

type T = [[number, number, number], [number, number, number]];
const at = (x: number, y: number): T => [[1, 0, x], [0, 1, y]];

/** The kit, and how many layers each page holds as Figma counts them (the page itself not included). */
export function figmaKit(shape: KitShape): {file: FigmaFile; layersByPage: Map<string, number>} {
  const pad = shape.nameBytes ? ' ' + 'x'.repeat(shape.nameBytes) : '';
  const node = (type: string, id: string, name: string, x: number, y: number, w: number, h: number, extra: Partial<FigmaNode> = {}): FigmaNode =>
    ({id, name: name + pad, type, relativeTransform: at(x, y), size: {x: w, y: h}, absoluteBoundingBox: {x, y, width: w, height: h}, fills: [], strokes: [], effects: [], ...extra}) as FigmaNode;
  const solid = {type: 'SOLID', color: {r: 0.2, g: 0.4, b: 0.9, a: 1}};
  const components: NonNullable<FigmaFile['components']> = {};
  const componentSets: NonNullable<FigmaFile['componentSets']> = {};
  const layersByPage = new Map<string, number>();
  const pages: FigmaNode[] = [];
  let next = 1;
  let previous: {id: string; children: string[]}[] = [];
  const id = () => `${next++}:${next++}`;
  // The inside of a variant (or of an instance of it, with Figma's `I<instance>;<main child>` ids).
  const inside = (prefix: string, ids: string[]): FigmaNode[] =>
    ids.map((childId, k) =>
      k === 0
        ? node('TEXT', prefix + childId, 'Label', 12, 8, 60, 20, {characters: 'Button', style: {fontFamily: 'Inter', fontWeight: 500, fontSize: 14}})
        : node('RECTANGLE', prefix + childId, `Part ${k}`, 4 * k, 4, 16, 16, {fills: [solid]}),
    );
  for (let p = 0; p < shape.pages; p++) {
    const pageId = `0:${p + 2}`;
    const setId = id();
    const variants: {id: string; children: string[]}[] = [];
    const variantNodes: FigmaNode[] = [];
    for (let v = 0; v < shape.variants; v++) {
      const variantId = id();
      const children = Array.from({length: shape.layersPerVariant - 1}, () => id());
      variants.push({id: variantId, children});
      components[variantId] = {key: `k${variantId}`, name: `color=${v % 8}, size=${v % 5}, state=${v % 3}`, componentSetId: setId};
      variantNodes.push(node('COMPONENT', variantId, `color=${v % 8}, size=${v % 5}, state=${v % 3}`, (v % 10) * 120, Math.floor(v / 10) * 48, 100, 36, {fills: [solid], children: inside('', children)}));
    }
    componentSets[setId] = {key: `s${setId}`, name: `Component ${p}`};
    const set = node('COMPONENT_SET', setId, `Component ${p}`, 0, 0, 1200, Math.ceil(shape.variants / 10) * 48, {children: variantNodes});
    const docs: FigmaNode[] = [];
    for (let f = 0; f < shape.docFrames; f++) {
      const frameId = id();
      const instances: FigmaNode[] = [];
      for (let k = 0; k < shape.instancesPerFrame; k++) {
        const source = shape.borrow && previous.length ? previous : variants;
        const variant = source[(f * shape.instancesPerFrame + k) % source.length];
        const instanceId = id();
        instances.push(node('INSTANCE', instanceId, 'Button', (k % 5) * 120, Math.floor(k / 5) * 48, 100, 36, {componentId: variant.id, fills: [solid], children: inside(`I${instanceId};`, variant.children)}));
      }
      docs.push(node('FRAME', frameId, `Examples ${f}`, 0, 2000 + f * 600, 640, 560, {children: instances}));
    }
    const layers = 1 + shape.variants * shape.layersPerVariant + shape.docFrames * (1 + shape.instancesPerFrame * shape.layersPerVariant);
    layersByPage.set(pageId, layers);
    previous = variants;
    pages.push({id: pageId, name: `Component ${p}`, type: 'CANVAS', children: [set, ...docs]} as FigmaNode);
  }
  const pictures = Array.from({length: shape.pictures}, (_, k) =>
    node('RECTANGLE', id(), `Picture ${k}`, k * 420, 0, 400, 300, {fills: [{type: 'IMAGE', scaleMode: 'FILL', imageRef: k.toString(16).padStart(40, 'a')}]}),
  );
  layersByPage.set('0:1', pictures.length);
  return {file: {name: 'Nuxt UI v4 (generated)', document: {children: [{id: '0:1', name: 'Cover', type: 'CANVAS', children: pictures} as FigmaNode, ...pages]} as FigmaNode, components, componentSets}, layersByPage};
}
