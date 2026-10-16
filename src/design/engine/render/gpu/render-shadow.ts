import type {DesignDocument, NodeId, SceneNode} from '../../../../../shared/design/types';
import {checkpointBytesOf, type RenderWasm, type RenderWasmDoc} from '../../../../../shared/design/render-engine';
import type {ImageCache} from '../../contracts';
import {isDesignImageCache} from '../../images';
import type {ChangeHint} from '../spatial-index';
import {createDocument} from '../../../../../shared/design/defaults';
import {bigFilesEnabled} from '../../../../../shared/design/big-files';
import {shadowIfNear} from '../../../../../shared/design/engine-switch';

// The renderer's shadow of the document (crates/render-wasm `RenderDoc`): fed the way the engine's shadow is
// (shared/design/engine-switch.ts `shadowFor`), by patches found between immutable documents — the ids the store
// reported changed when it has them, else one identity pass over the node table — never by scene subtrees. It also
// hands the renderer the pictures the page uses, decoded once each.

const PART = 2000;

export class RenderShadow {
  readonly doc: RenderWasmDoc;
  private document: DesignDocument | null = null;
  /** The node objects as of the last sync (a drag rewrites one table in place; changes are found against this copy). */
  private readonly seen = new Map<NodeId, SceneNode>();
  private readonly registered = new Set<string>();
  /** Picture refs the page used that the cache could not give yet (drawn as a checkerboard; a load repaints). */
  readonly pendingPictures = new Set<string>();

  constructor(wasm: RenderWasm, private readonly images: ImageCache) {
    // An empty but valid document until the first sync (the model checks every table).
    this.doc = new wasm.RenderDoc(JSON.stringify(createDocument('page')));
  }

  /** Brings the shadow to `doc`; true when it was reloaded (every tile is stale). */
  sync(doc: DesignDocument, hint?: ChangeHint): boolean {
    if (doc === this.document) return false;
    const previous = this.document;
    if (!previous || !sameTables(previous, doc)) {
      this.reload(doc);
      return true;
    }
    const patch: Record<NodeId, SceneNode | null> = {};
    let changed = 0;
    if (hint && hint.from === previous) {
      for (const id of hint.ids) {
        const node = doc.nodes[id];
        if (node !== this.seen.get(id)) {
          patch[id] = node ?? null;
          changed++;
        }
      }
    } else {
      for (const id in doc.nodes) {
        const node = doc.nodes[id];
        if (node !== this.seen.get(id)) {
          patch[id] = node;
          changed++;
        }
      }
      for (const id of this.seen.keys()) if (!(id in doc.nodes)) {
        patch[id] = null;
        changed++;
      }
    }
    if (changed > this.seen.size / 2 && changed > 64) {
      this.reload(doc);
      return true;
    }
    if (changed) {
      this.doc.apply_patch(JSON.stringify({nodes: patch}));
      for (const id in patch) {
        const node = patch[id];
        if (node) this.seen.set(id, node);
        else this.seen.delete(id);
      }
    }
    this.document = doc;
    return false;
  }

  /** How the last reload went in (tests, the bench's notes). */
  lastLoad: 'checkpoint' | 'json' | 'parts' | 'bytes' | null = null;

  private reload(doc: DesignDocument): void {
    const ids = Object.keys(doc.nodes);
    this.seen.clear();
    const fetched = checkpointBytesOf(doc);
    if (fetched && this.loadFetched(fetched)) this.lastLoad = 'checkpoint';
    else if (bigFilesEnabled() && ids.length > PART && this.loadBytes(doc)) this.lastLoad = 'bytes';
    else if (ids.length <= PART) {
      this.lastLoad = 'json';
      this.doc.load(JSON.stringify(doc));
    } else {
      // The skeleton, then the nodes in parts: the wasm memory's peak is one part's JSON, not the file's.
      this.lastLoad = 'parts';
      this.doc.load(JSON.stringify({...doc, nodes: {}}));
      for (let i = 0; i < ids.length; i += PART) {
        const part: Record<NodeId, SceneNode> = {};
        for (const id of ids.slice(i, i + PART)) part[id] = doc.nodes[id];
        this.doc.load_part(JSON.stringify({nodes: part}));
      }
    }
    for (const id of ids) this.seen.set(id, doc.nodes[id]);
    this.document = doc;
    this.registered.clear();
    this.pendingPictures.clear();
  }

  /** The big-file path (DESIGN_BIG_FILES): the engine's shadow document, when it stands at `doc` already (the store's
   *  readers keep it there), encoded in S1's binary codec and decoded by the renderer — the file's JSON is never written
   *  nor parsed. False when the shadow is not there or not near, or the codec refuses: the JSON path follows. */
  private loadBytes(doc: DesignDocument): boolean {
    try {
      const handle = shadowIfNear(doc);
      if (!handle) return false;
      this.doc.load_bytes(handle.encode());
      return true;
    } catch {
      return false;
    }
  }

  /** The bytes the document was opened from (BIG stage D): loaded as fetched, with no `encode()` of the engine's shadow
   *  (1.2 s at 500 000 layers). False when the codec refuses them: the next path follows. */
  private loadFetched(bytes: Uint8Array): boolean {
    try {
      this.doc.load_bytes(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Registers every picture of the document the cache has decoded; the rest stay pending. */
  syncPictures(doc: DesignDocument): void {
    for (const ref in doc.images ?? {}) {
      if (this.registered.has(ref)) continue;
      const source = isDesignImageCache(this.images) ? this.images.source(ref, doc, 1, undefined)?.source ?? null : this.images.get(ref, doc);
      if (!source) {
        this.pendingPictures.add(ref);
        continue;
      }
      const pixels = decode(source);
      if (!pixels) {
        this.pendingPictures.add(ref);
        continue;
      }
      this.doc.register_image(ref, pixels.width, pixels.height, pixels.rgba);
      this.registered.add(ref);
      this.pendingPictures.delete(ref);
    }
  }

  dispose(): void {
    this.doc.free();
  }
}

function sameTables(a: DesignDocument, b: DesignDocument): boolean {
  return a.pages === b.pages && a.images === b.images && a.styles === b.styles && a.variables === b.variables && a.variableCollections === b.variableCollections;
}

/** Straight-alpha RGBA8 of a decoded picture, through a 2D canvas. */
function decode(source: CanvasImageSource): {width: number; height: number; rgba: Uint8Array} | null {
  const width = (source as {naturalWidth?: number}).naturalWidth ?? (source as {width: number}).width;
  const height = (source as {naturalHeight?: number}).naturalHeight ?? (source as {height: number}).height;
  if (!(width > 0 && height > 0)) return null;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), {width, height});
  const ctx = (canvas as OffscreenCanvas).getContext('2d', {willReadFrequently: true}) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return {width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)};
}
