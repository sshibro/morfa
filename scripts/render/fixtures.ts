// Lane B4's X4 fixtures, shared by scripts/render/requests.ts (the service's request files) and
// scripts/render/references.ts (today's Chromium PDFs of the same pages): the same documents and the same picture bytes.
import sharp from 'sharp';
import type {DesignDocument, ImageAsset, NodeId} from '../../shared/design/types';
import {pdfPagePlan, readingOrder, textFamilies} from '../../shared/design/pdf-export';
import {heavyPage, productFile} from '../../tests/helpers/design-big-files';
import {generate} from '../bench/gen-file';
import {encodeRenderRequest, pdfJobHeader, rasterJobHeader, renderFaces, type RasterKind, type RenderHeader} from '../../server/design/pdf/service';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import {normalizeDocument} from '../../shared/design/normalize';
import {testMeasurer} from '../../tests/helpers/design-big-files';

/** pdf-check.ts's pictures: a photo-like JPEG, every other one a PNG with a transparent ramp. */
export async function pictures(count: number): Promise<{assets: Record<string, ImageAsset>; bytes: Uint8Array[]}> {
  const assets: Record<string, ImageAsset> = {};
  const bytes: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const width = 320 + i * 40, height = 240 + i * 30;
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const k = (y * width + x) * 4;
        raw[k] = (x * 255) / width;
        raw[k + 1] = (y * 255) / height;
        raw[k + 2] = 128 + 127 * Math.sin((x + y + i * 37) / 23);
        raw[k + 3] = i % 2 && x < width / 4 ? Math.round((255 * x) / (width / 4)) : 255;
      }
    const image = sharp(raw, {raw: {width, height, channels: 4}});
    const png = i % 2 === 1;
    bytes.push(png ? await image.png().toBuffer() : await image.flatten({background: '#ffffff'}).jpeg({quality: 90}).toBuffer());
    assets[`img${i}`] = {url: `/uploads/b4-picture-${i}.${png ? 'png' : 'jpg'}`, width, height};
  }
  return {assets, bytes};
}

export const frames = (doc: DesignDocument): NodeId[] => doc.pages.flatMap(page => readingOrder(doc, doc.nodes[page].children ?? [])).filter(id => pdfPagePlan(doc, id)).slice(0, 50);


/** A PDF job of `ids` (pictures in `doc.images` order), text measured by `measure`. */
export function pdfRequest(doc: DesignDocument, ids: NodeId[], bytes: Uint8Array[], measure: RenderHeader['measure'] = 'fixed', account = 'bench'): Buffer {
  const plans = ids.map(id => pdfPagePlan(doc, id)!);
  const refs = Object.keys(doc.images);
  const families = new Set<string>();
  for (const plan of plans) for (const family of textFamilies(doc, plan.ids)) families.add(family);
  const {header} = pdfJobHeader(plans, {
    account,
    title: 'X4',
    families,
    pictures: refs.map((ref, index) => ({ref, href: `https://pdf.b4.invalid/pictures/${index}`, length: bytes[index].length})),
  });
  header.measure = measure;
  header.measurements = undefined;
  return encodeRenderRequest(header, JSON.stringify(doc), bytes);
}

/** The X-rows' requests: X4's two 50-page files and X3's SVG of heavyPage() (f20k seed 0). */
export async function xRequests(measure: RenderHeader['measure'] = 'fixed', account = 'bench'): Promise<{x4Product: Buffer; x4Page: Buffer; x3: Buffer}> {
  const {assets, bytes} = await pictures(6);
  const product = productFile(assets);
  const page = generate({kind: 'page', layers: 50 * 501, seed: 7});
  const heavy = heavyPage();
  const ids = heavy.nodes[heavy.pages[0]].children!;
  return {
    x4Product: pdfRequest(product, frames(product), bytes, measure, account),
    x4Page: pdfRequest(page, frames(page), [], measure, account),
    x3: encodeRenderRequest({kind: 'svg', account, ids, measure, fonts: renderFaces(['Inter']).faces, pictures: []}, JSON.stringify(heavy), []),
  };
}

/** A raster job of `ids` (lane L4's vello_cpu in the service): `kind` png/jpeg/webp/thumbnail at `scale`, the pictures
 *  in `doc.images` order (their bytes in `bytes`, or an URL the service never fetches when `bytes` is empty), text by
 *  the service's own fonts. */
export function rasterRequest(doc: DesignDocument, ids: NodeId[], options: {kind: RasterKind; scale?: number; maxSide?: number; quality?: number; bytes?: Uint8Array[]; hrefs?: string[]; account?: string}): Buffer {
  const refs = Object.keys(doc.images);
  const bytes = options.bytes ?? [];
  const pictures = refs.slice(0, bytes.length).map((ref, index) => ({ref, href: options.hrefs?.[index] ?? `https://raster.l4.invalid/pictures/${index}`, length: bytes[index].length}));
  const {header} = rasterJobHeader(ids, {kind: options.kind, account: options.account ?? 'bench', scale: options.scale, maxSide: options.maxSide, quality: options.quality, families: textFamilies(doc, ids), pictures});
  return encodeRenderRequest(header, JSON.stringify(doc), bytes);
}

/** X2's frame (docs/TARGETS.md §6): 3840 × 2160, 20 000 layers inside — 40 cards of 500 layers (rectangles with corner
 *  radii and drop shadows, ellipses, lines, texts) on a dark background; effects on. Deterministic. */
export function x2Frame(): DesignDocument {
  const doc = createDocument('page', 'X2');
  let n = 0;
  const add = (node: ReturnType<typeof createNode>) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
    return node.id;
  };
  const frame = add(createNode('FRAME', {id: 'x2', parentId: 'page', x: 0, y: 0, width: 3840, height: 2160, fills: [solid({r: 0.09, g: 0.1, b: 0.13})]}));
  const palette = [{r: 0.95, g: 0.45, b: 0.35}, {r: 0.35, g: 0.65, b: 0.95}, {r: 0.8, g: 0.95, b: 0.35}, {r: 0.6, g: 0.4, b: 0.85}, {r: 0.95, g: 0.85, b: 0.3}];
  for (let c = 0; c < 40; c++) {
    const col = c % 8, row = Math.floor(c / 8);
    const card = add(createNode('FRAME', {id: `card${c}`, parentId: frame, x: 40 + col * 470, y: 40 + row * 420, width: 440, height: 390, cornerRadius: 24, fills: [solid({r: 0.16, g: 0.17, b: 0.21})]}));
    doc.nodes[card].effects = [{type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.4}, offset: {x: 0, y: 12}, radius: 32, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false}];
    for (let i = 0; i < 499; i++) {
      const kind = i % 10;
      const x = 16 + (i % 20) * 21, y = 16 + Math.floor(i / 20) * 14;
      const color = palette[(i + c) % palette.length];
      const id = `n${++n}`;
      if (kind === 0) {
        const text = createNode('TEXT', {id, parentId: card, x, y, width: 80, height: 14});
        text.text = {...defaultTextProps('Layer ' + i), style: {...defaultTextProps().style, fontSize: 10}};
        add(text);
      } else if (kind === 1) add(createNode('ELLIPSE', {id, parentId: card, x, y, width: 16, height: 12, fills: [solid(color)]}));
      else if (kind === 2) add(createNode('LINE', {id, parentId: card, x, y: y + 6, width: 18, height: 0, strokes: [solid(color)], strokeWeight: 1}));
      else {
        const rect = createNode('RECTANGLE', {id, parentId: card, x, y, width: 18, height: 12, cornerRadius: 3, fills: [solid({...color})]});
        if (kind === 3) rect.effects = [{type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.35}, offset: {x: 0, y: 2}, radius: 4, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false}];
        if (kind === 4) rect.opacity = 0.6;
        add(rect);
      }
    }
  }
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}

/** The raster rows' requests: X1 the thumbnail of heavyPage()'s page (512 px), X2 the PNG of x2Frame() at scale 1
 *  (3840 × 2160), both with the catalogue faces (the service lays text out itself). */
export function rasterRequests(account = 'bench'): {x1: Buffer; x2: Buffer; layers: number} {
  const heavy = heavyPage();
  const frame = x2Frame();
  return {
    x1: rasterRequest(heavy, [heavy.pages[0]], {kind: 'thumbnail', account}),
    x2: rasterRequest(frame, ['x2'], {kind: 'png', scale: 1, account}),
    layers: Object.keys(frame.nodes).length - 2,
  };
}
