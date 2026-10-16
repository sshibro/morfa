import type {DesignDocument, ImageAsset, ImagePaint, ImageRef, NodeId, Paint, SceneNode, Vec} from '../../../../shared/design/types';
import {createDocument, createNode, newId} from '../../../../shared/design/defaults';
import {validateDocument} from '../../../../shared/design/schema';
import {apply, invert, worldBox, worldMatrix} from '../../../../shared/design/geometry';
import {SVG_IMPORT_LIMITS} from '../../../../shared/design/svg-import';
import {importSvgString} from '../../import/svg-dom';
import type {CommandContext} from '../commands/registry';
import {removeNodes} from '../commands/structure';
import type {PasteData} from '../commands/clipboard';
import {currentViewport, type DesignStore} from '../store';
import {DrawTool, drawParent, flowIndexAt, type Drawing} from './draw-common';
import type {Rect} from '../../../../shared/design/geometry';
import type {ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// "Image" (⇧⌘K, "Place image…"): pictures become rectangles with an image fill
// (FILL), sized to the picture. Three ways in, as in Figma:
//   - the tool: a file dialog (several files), then each click places the next picture at its own size,
//     or a drag sizes it in its proportions;
//   - files dropped on the canvas land where they are dropped, side by side;
//   - a picture pasted from the clipboard lands in the middle of the view.
// The rectangle appears at once with an empty image fill, which the renderer shows as a checkerboard
// while the upload runs (`services.uploadImage`), then takes the stored picture. SVG files and SVG
// text are not pictures: they become layers through `importSvgString` (DOMParser, never in the page),
// and its warnings are shown as toasts.

/** What the image tools need from the open editor (bound by the canvas overlay, src/design/editor/Rulers.tsx). */
export type ImageServices = {
  upload(image: Blob, name?: string): Promise<{ref: ImageRef; asset: ImageAsset}>;
  toast(message: string, kind?: 'success' | 'error'): void;
  /** CSS px of the canvas (the view's centre and its size). */
  canvasSize?(): {width: number; height: number};
};

const servicesByStore = new WeakMap<DesignStore, ImageServices>();

/** Makes pictures placeable in this editor. Returns the undo of the binding. */
export function bindImageServices(store: DesignStore, services: ImageServices): () => void {
  servicesByStore.set(store, services);
  return () => {
    if (servicesByStore.get(store) === services) servicesByStore.delete(store);
  };
}

export const imageServicesFor = (store: DesignStore) => servicesByStore.get(store) ?? null;

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const RASTER_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif)$/i;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,.svg';
/** Side of the cursor's preview of the next picture, CSS px. */
const THUMB = 56;
/** Gap between pictures dropped together. */
const DROP_GAP = 20;

export const isSvgFile = (file: Pick<File, 'type' | 'name'>) => file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
export const isRasterFile = (file: Pick<File, 'type' | 'name'>) => RASTER_TYPES.has(file.type) || (!file.type && RASTER_EXTENSIONS.test(file.name));
export const isImageFile = (file: Pick<File, 'type' | 'name'>) => isSvgFile(file) || isRasterFile(file);
export const looksLikeSvg = (text: string) => {
  const start = text.trimStart().slice(0, 4096);
  return /^<svg[\s>]/i.test(start) || (/^<\?xml/i.test(start) && /<svg[\s>]/i.test(start));
};

/** A file's name as a layer name: without the extension, at most 100 characters. */
export const layerNameFromFile = (name: string) => (name.replace(/\.[a-z0-9]{1,5}$/i, '').trim() || 'Image').slice(0, 100);

export type PreparedImage =
  | {kind: 'raster'; file: Blob; name: string; width: number; height: number; thumb: CanvasImageSource | null}
  | {kind: 'svg'; name: string; text: string};

/** Reads what is needed to place a file: a picture's natural size (and a small preview), an SVG's
 *  text. Null for anything else or a file that cannot be read. */
export async function prepareImage(file: File): Promise<PreparedImage | {error: string}> {
  const name = layerNameFromFile(file.name);
  if (isSvgFile(file)) {
    if (file.size > SVG_IMPORT_LIMITS.inputBytes) return {error: `"${file.name}": SVG is larger than 2 MB`};
    return {kind: 'svg', name, text: await file.text()};
  }
  if (!isRasterFile(file)) return {error: `"${file.name}": this format cannot be placed (PNG, JPG, WebP, GIF, AVIF and SVG work)`};
  try {
    const bitmap = await createImageBitmap(file);
    const {width, height} = bitmap;
    const thumb = makeThumb(bitmap);
    bitmap.close();
    if (!width || !height) return {error: `"${file.name}": empty image`};
    return {kind: 'raster', file, name, width, height, thumb};
  } catch {
    return {error: `"${file.name}": could not read the image`};
  }
}

function makeThumb(bitmap: ImageBitmap): CanvasImageSource | null {
  if (typeof document === 'undefined') return null;
  const scale = Math.min(1, THUMB / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale * 2));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale * 2));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A picture's size within `max`, in its proportions (never enlarged). */
export function fitImageSize(width: number, height: number, max: {width: number; height: number}): {width: number; height: number} {
  const scale = Math.min(1, max.width / width, max.height / height);
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

/** Figma's largest picture side: a bigger one comes in scaled down to it. */
export const IMAGE_MAX_SIDE = 4096;

/** A picture's size when it is placed, dropped or pasted, as in Figma: its natural size in pixels (a
 *  393 × 852 screenshot is 393 × 852 whatever the zoom), longest side at most 4096. */
export const placedImageSize = (width: number, height: number) => fitImageSize(width, height, {width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE});

let picking: Promise<File[]> | null = null;

/** The system file dialog for pictures (several at once). One dialog at a time. The input stays in the page until
 *  the dialog answers, as `pickFile` keeps its own (commands/file.ts): a detached input is held by nothing once
 *  `click()` returns, and a garbage collection while the dialog opens takes it, and the picked files with it. */
export function pickImageFiles(): Promise<File[]> {
  if (picking) return picking;
  if (typeof document === 'undefined') return Promise.resolve([]);
  picking = new Promise<File[]>(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = IMAGE_ACCEPT;
    input.style.display = 'none';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      picking = null;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
  return picking;
}

// ── Placing ──────────────────────────────────────────────────────────────────────────────────────

export const imagePaint = (imageRef: ImageRef = ''): Paint => ({type: 'IMAGE', imageRef, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'});

/** A rectangle with an image fill waiting for its upload. */
export function imageNode(id: NodeId, name: string, box: Rect): SceneNode {
  return createNode('RECTANGLE', {id, name, x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height), fills: [imagePaint()]});
}

/** Uploads a placed picture and puts its ref into the waiting fill; on failure removes the
 *  placeholder and says why. */
export async function completeUpload(store: DesignStore, services: ImageServices, id: NodeId, file: Blob, name: string): Promise<boolean> {
  // The waiting fill. A copy made while the picture uploads (⌘D, Alt-drag) shares this very object, so it gets the
  // picture too instead of staying an empty placeholder.
  const waiting = store.getState().doc.nodes[id]?.fills.find((paint): paint is ImagePaint => paint.type === 'IMAGE' && !paint.imageRef) ?? null;
  /** The placed layer (its fill may have been edited since) and every copy sharing the waiting fill. */
  const holders = () => {
    const nodes = store.getState().doc.nodes;
    const out = waiting ? Object.values(nodes).filter(node => node.fills?.includes(waiting)) : [];
    if (nodes[id] && !out.includes(nodes[id])) out.push(nodes[id]);
    return out;
  };
  try {
    const {ref} = await services.upload(file, name);
    const found = holders();
    const ids = new Set(found.map(node => node.id));
    // The waiting fill gets the picture; on a holder whose fill was edited since (its opacity), its first empty picture fill.
    const fill = (node: SceneNode): SceneNode => {
      if (!node.fills) return node;
      if (waiting && node.fills.includes(waiting)) return {...node, fills: node.fills.map(paint => (paint === waiting ? {...waiting, imageRef: ref} : paint))};
      if (!ids.has(node.id)) return node;
      const at = node.fills.findIndex(paint => paint.type === 'IMAGE' && !paint.imageRef);
      return at < 0 ? node : {...node, fills: node.fills.map((paint, index) => (index === at ? {...paint, imageRef: ref} as Paint : paint))};
    };
    // Part of placing the picture, not a step of its own: one undo takes the picture away, a redo brings it back
    // with its image (the history's copies of the placeholder get the ref too).
    store.transact('Image', tx => {
      for (const node of found) {
        const next = fill(node);
        if (next !== node) tx.update(node.id, {fills: next.fills});
      }
    }, {history: false});
    store.amendHistory(fill);
    return found.length > 0;
  } catch (error) {
    const empty = holders().filter(node => node.fills.some(paint => paint.type === 'IMAGE' && !paint.imageRef));
    if (empty.length) store.transact('Image not uploaded', tx => removeNodes(tx, empty.map(node => node.id)));
    services.toast(error instanceof Error && error.message ? error.message : `Could not upload "${name}"`, 'error');
    return false;
  }
}

function dataUrlToBlob(url: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  try {
    if (!match[2]) return new Blob([decodeURIComponent(match[3])], {type: match[1]});
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], {type: match[1]});
  } catch {
    return null;
  }
}

/** The container a picture placed at `at` goes into and the point in its space. */
function placement(doc: DesignDocument, pageId: NodeId, at: Vec, index: ReturnType<NonNullable<CommandContext['index']>> | null) {
  const parentId = drawParent(doc, pageId, at, 'RECTANGLE', index);
  const toLocal = invert(worldMatrix(doc, parentId));
  return {parentId, toLocal, index: flowIndexAt(doc, parentId, apply(toLocal, at))};
}

/** Why the server would refuse the imported layers (shared/design/schema.ts on a document of just them), or null.
 *  An SVG comes from anywhere: a coordinate past 10⁹ or a field over its limit would otherwise enter the document,
 *  and autosave, which carries a refused patch into every later one, would stop saving the file. */
function unstorable(nodes: readonly SceneNode[], rootId: NodeId): string | null {
  const doc = createDocument('svg-check');
  const map: Record<NodeId, SceneNode> = {...doc.nodes};
  for (const node of nodes) map[node.id] = node.id === rootId ? {...node, parentId: 'svg-check'} : node;
  map['svg-check'] = {...map['svg-check'], children: [rootId]};
  const checked = validateDocument(JSON.parse(JSON.stringify({...doc, nodes: map})));
  return checked.ok ? null : checked.error;
}

/** Imports SVG text as layers centred on `at` (page space; with `anchor: 'left'`, its left edge on
 *  it, vertically centred). Returns the new root or null. */
export function insertSvg(store: DesignStore, text: string, at: Vec, options: {name?: string; services?: ImageServices | null; index?: CommandContext['index']; anchor?: 'centre' | 'left'} = {}): NodeId | null {
  const services = options.services ?? imageServicesFor(store);
  const result = importSvgString(text, {measurer: store.measurer, ...(options.name ? {name: options.name} : {})});
  if ('error' in result) {
    services?.toast(result.message, 'error');
    return null;
  }
  const root = result.nodes.find(node => node.id === result.rootId);
  if (!root) return null;
  const refused = unstorable(result.nodes, result.rootId);
  if (refused) {
    services?.toast(`Could not paste SVG: ${refused.replace(/\.$/, '')}.`, 'error');
    return null;
  }
  const state = store.getState();
  const place = placement(state.doc, state.pageId, at, options.index?.() ?? null);
  const centre = apply(place.toLocal, at);
  const pixel = state.ui.snapToPixel;
  const x = options.anchor === 'left' ? centre.x : centre.x - root.width / 2, y = centre.y - root.height / 2;
  store.transact('Paste SVG', tx => {
    for (const node of result.nodes) {
      if (node.id === result.rootId) tx.create({...node, x: pixel ? Math.round(x) : x, y: pixel ? Math.round(y) : y}, place.parentId, place.index);
      else tx.create(node, node.parentId!);
    }
    return {select: [result.rootId]};
  });
  for (const warning of new Set(result.warnings)) services?.toast(warning);
  if (services) {
    for (const image of result.images) {
      const blob = dataUrlToBlob(image.dataUrl);
      if (blob) void completeUpload(store, services, image.nodeId, blob, root.name);
    }
  }
  return result.rootId;
}

/** Places files centred on `at` (page space) in a row, all pictures in one undo step, each upload
 *  filling its rectangle when done. SVG files become layers. Returns the new layers' ids. */
export async function placeFiles(store: DesignStore, services: ImageServices, files: readonly File[], at: Vec, options: {index?: CommandContext['index']} = {}): Promise<NodeId[]> {
  const prepared = await Promise.all(files.map(prepareImage));
  const state = store.getState();
  const items: {item: PreparedImage; width: number; height: number}[] = [];
  for (const entry of prepared) {
    if ('error' in entry) services.toast(entry.error, 'error');
    else if (entry.kind === 'raster') items.push({item: entry, ...placedImageSize(entry.width, entry.height)});
    else items.push({item: entry, width: 0, height: 0});
  }
  const rasters = items.filter(entry => entry.item.kind === 'raster');
  const total = rasters.reduce((sum, entry) => sum + entry.width, 0) + DROP_GAP * Math.max(0, rasters.length - 1);
  const created: NodeId[] = [];
  if (rasters.length) {
    const doc = store.getState().doc;
    const place = placement(doc, state.pageId, at, options.index?.() ?? null);
    const centre = apply(place.toLocal, at);
    let left = centre.x - total / 2;
    const uploads: {id: NodeId; file: Blob; name: string}[] = [];
    store.transact(rasters.length > 1 ? 'Paste images' : 'Paste image', tx => {
      for (const entry of rasters) {
        const item = entry.item as Extract<PreparedImage, {kind: 'raster'}>;
        const id = newId();
        const name = item.name;
        const box = {x: Math.round(left), y: Math.round(centre.y - entry.height / 2), width: entry.width, height: entry.height};
        tx.create(imageNode(id, name, box), place.parentId, place.index === undefined ? undefined : place.index + created.length);
        created.push(id);
        uploads.push({id, file: item.file, name: item.name});
        left += entry.width + DROP_GAP;
      }
      return {select: created};
    });
    for (const upload of uploads) void completeUpload(store, services, upload.id, upload.file, upload.name);
  }
  // SVG files continue the row to the right of the pictures (a lone one is centred on the point).
  let right: number | null = rasters.length ? at.x + total / 2 : null;
  for (const entry of items) {
    if (entry.item.kind !== 'svg') continue;
    const anchor = right === null ? at : {x: right + DROP_GAP, y: at.y};
    const id = insertSvg(store, entry.item.text, anchor, {name: entry.item.name, services, index: options.index, anchor: right === null ? 'centre' : 'left'});
    if (!id) continue;
    created.push(id);
    const box = worldBox(store.getState().doc, id);
    right = box.x + box.width;
  }
  if (created.length) store.setSelection(created);
  return created;
}

/** The paste handler (`registerPasteHandler`): pictures and SVG from the clipboard land in the
 *  middle of the view. */
export function pasteImages(data: PasteData, ctx: CommandContext): boolean {
  const services = imageServicesFor(ctx.store);
  const state = ctx.store.getState();
  const size = ctx.canvasSize();
  const viewport = currentViewport(state);
  const centre = {x: viewport.x + size.width / 2 / viewport.zoom, y: viewport.y + size.height / 2 / viewport.zoom};
  const files = data.files.filter(isImageFile);
  if (files.length && services) {
    void placeFiles(ctx.store, services, files, centre, {index: ctx.index});
    return true;
  }
  const text = data.text ?? '';
  if (text && looksLikeSvg(text)) {
    insertSvg(ctx.store, text, centre, {services, index: ctx.index});
    return true;
  }
  return false;
}

// ── The tool ─────────────────────────────────────────────────────────────────────────────────────

const queues = new WeakMap<DesignStore, PreparedImage[]>();

/** "Place image…": the file dialog, then the image tool places the chosen files one click at a time. */
export async function startPlaceImage(store: DesignStore): Promise<void> {
  const files = await pickImageFiles();
  await queueFiles(store, files);
}

async function queueFiles(store: DesignStore, files: readonly File[]) {
  const services = imageServicesFor(store);
  if (!files.length) {
    if (store.getState().tool === 'image' && !queues.get(store)?.length) store.setTool('move');
    return;
  }
  const prepared = await Promise.all(files.map(prepareImage));
  const ready: PreparedImage[] = [];
  for (const entry of prepared) {
    if ('error' in entry) services?.toast(entry.error, 'error');
    else ready.push(entry);
  }
  queues.set(store, ready);
  store.setTool(ready.length ? 'image' : 'move');
}

export class ImageTool extends DrawTool {
  private pointer: Vec | null = null;
  private store: DesignStore | null = null;

  constructor() {
    super({id: 'image', type: 'RECTANGLE', label: 'Image'});
  }

  private queue(store: DesignStore): PreparedImage[] {
    let queue = queues.get(store);
    if (!queue) queues.set(store, (queue = []));
    return queue;
  }

  activate(ctx: ToolContext) {
    super.activate(ctx);
    this.store = ctx.store;
    if (!imageServicesFor(ctx.store)) {
      ctx.setTool('move');
      return;
    }
    if (!this.queue(ctx.store).length) void startPlaceImage(ctx.store);
  }

  deactivate(ctx: ToolContext) {
    super.deactivate(ctx);
    queues.delete(ctx.store);
    this.pointer = null;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    const next = this.queue(ctx.store)[0];
    if (!next || e.button !== 0) return;
    if (next.kind === 'svg') {
      this.queue(ctx.store).shift();
      insertSvg(ctx.store, next.text, e.page, {name: next.name, index: () => ctx.index()});
      this.afterPlacing(ctx);
      return;
    }
    super.onPointerDown(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.pointer = e.screen;
    if (!this.busy()) ctx.requestOverlay();
    super.onPointerMove(e, ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.code === 'Escape' && !this.busy()) queues.delete(ctx.store);
    return super.onKeyDown(e, ctx);
  }

  protected ratio(): number | null {
    const next = this.store ? this.queue(this.store)[0] : undefined;
    return next?.kind === 'raster' ? next.width / next.height : null;
  }

  protected clickSize() {
    const next = this.store ? this.queue(this.store)[0] : undefined;
    if (next?.kind !== 'raster' || !this.store) return super.clickSize();
    return placedImageSize(next.width, next.height);
  }

  protected clickFromCenter() {
    return true;
  }

  protected makeNode(drawing: Drawing, box: Rect): SceneNode {
    const next = this.store ? this.queue(this.store)[0] : undefined;
    return imageNode(drawing.id, next?.name ?? drawing.name, box);
  }

  protected created(id: NodeId, ctx: ToolContext) {
    const next = this.queue(ctx.store).shift();
    const services = imageServicesFor(ctx.store);
    if (next?.kind === 'raster' && services) void completeUpload(ctx.store, services, id, next.file, next.name);
    this.afterPlacing(ctx);
  }

  private afterPlacing(ctx: ToolContext) {
    if (this.queue(ctx.store).length) ctx.requestOverlay();
    else ctx.setTool('move');
  }

  /** The next picture follows the cursor, with how many are left. */
  drawOverlay(ctx2d: CanvasRenderingContext2D, _view: ViewHelpers) {
    const next = this.store ? this.queue(this.store)[0] : undefined;
    if (!next || !this.pointer || this.busy()) return;
    const left = this.queue(this.store!).length;
    const x = Math.round(this.pointer.x + 14), y = Math.round(this.pointer.y + 14);
    ctx2d.save();
    if (next.kind === 'raster' && next.thumb) {
      const scale = Math.min(1, THUMB / Math.max(next.width, next.height));
      const w = Math.max(8, Math.round(next.width * scale)), h = Math.max(8, Math.round(next.height * scale));
      ctx2d.shadowColor = 'rgba(0, 0, 0, 0.25)';
      ctx2d.shadowBlur = 6;
      ctx2d.shadowOffsetY = 1;
      ctx2d.fillStyle = '#FFFFFF';
      ctx2d.fillRect(x - 2, y - 2, w + 4, h + 4);
      ctx2d.shadowColor = 'transparent';
      ctx2d.drawImage(next.thumb, x, y, w, h);
      if (left > 1) badge(ctx2d, x + w + 2, y - 2, String(left));
    } else if (left > 1) {
      badge(ctx2d, x, y, String(left));
    }
    ctx2d.restore();
  }
}

function badge(ctx2d: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx2d.font = '600 10px "Inter Variable", Inter, system-ui, sans-serif';
  const width = Math.max(16, Math.ceil(ctx2d.measureText(text).width) + 8);
  ctx2d.beginPath();
  ctx2d.roundRect(x - width / 2, y - 8, width, 16, 8);
  ctx2d.fillStyle = '#0D99FF';
  ctx2d.fill();
  ctx2d.fillStyle = '#FFFFFF';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(text, x, y + 0.5);
}

export const createImageTool = () => new ImageTool();
