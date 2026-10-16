import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {renderBounds} from '../../../../shared/design/bounds';
import {worldBox} from '../../../../shared/design/geometry';
import {paintNodeTree} from '../../engine/render';
import type {EditorServices} from '../../editor/services';

// Component thumbnails for the assets panel, painted with the renderer's own `paintNodeTree`. A
// thumbnail is drawn only when its tile is on screen, at most a few milliseconds of them per frame,
// and kept per (component, size) until the component's version changes, so scrolling back, switching
// between list and grid or reopening the tab copies a bitmap instead of painting again.

type Cached = {version: number; canvas: HTMLCanvasElement};
type Job = {id: NodeId; version: number; width: number; height: number; target: HTMLCanvasElement};

const FRAME_BUDGET_MS = 6;

export class ThumbnailPainter {
  private cache = new Map<string, Cached>();
  private queue: Job[] = [];
  private frame = 0;

  /** `docOf`: the document the ids name, when it is not the open file's (a shared library's snapshot). */
  constructor(private readonly services: EditorServices, private readonly docOf?: () => DesignDocument) {}

  /** Draws the thumbnail into `target` (CSS size `width`×`height`) now from the cache, or soon. */
  draw(target: HTMLCanvasElement, id: NodeId, version: number, width: number, height: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    if (target.width !== pixelWidth || target.height !== pixelHeight) {
      target.width = pixelWidth;
      target.height = pixelHeight;
    }
    const cached = this.cache.get(this.key(id, pixelWidth, pixelHeight));
    if (cached && cached.version === version) {
      copy(cached.canvas, target);
      return;
    }
    this.queue = this.queue.filter(job => job.target !== target);
    this.queue.push({id, version, width: pixelWidth, height: pixelHeight, target});
    if (!this.frame) this.frame = requestAnimationFrame(() => this.run());
  }

  /** Forgets a target that left the screen. */
  cancel(target: HTMLCanvasElement) {
    this.queue = this.queue.filter(job => job.target !== target);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.queue = [];
    this.cache.clear();
  }

  private key(id: NodeId, width: number, height: number) {
    return `${id}@${width}x${height}`;
  }

  private run() {
    this.frame = 0;
    const started = performance.now();
    while (this.queue.length && performance.now() - started < FRAME_BUDGET_MS) {
      const job = this.queue.shift()!;
      if (!job.target.isConnected) continue;
      const key = this.key(job.id, job.width, job.height);
      let cached = this.cache.get(key);
      if (!cached || cached.version !== job.version) {
        const canvas = cached?.canvas ?? document.createElement('canvas');
        canvas.width = job.width;
        canvas.height = job.height;
        this.paint(canvas, job.id);
        cached = {version: job.version, canvas};
        this.cache.set(key, cached);
      }
      copy(cached.canvas, job.target);
    }
    if (this.queue.length) this.frame = requestAnimationFrame(() => this.run());
  }

  private paint(canvas: HTMLCanvasElement, id: NodeId) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const doc = this.docOf ? this.docOf() : this.services.store.getState().doc;
    if (!doc.nodes[id]) return;
    const bounds = renderBounds(doc, id, {measurer: this.services.fonts.measurer, includeHidden: true}) ?? worldBox(doc, id);
    const pad = Math.round(Math.min(canvas.width, canvas.height) * 0.12);
    const room = {width: canvas.width - 2 * pad, height: canvas.height - 2 * pad};
    const scale = Math.min(room.width / Math.max(bounds.width, 1e-3), room.height / Math.max(bounds.height, 1e-3), 4);
    const x = (canvas.width - bounds.width * scale) / 2 - bounds.x * scale;
    const y = (canvas.height - bounds.height * scale) / 2 - bounds.y * scale;
    try {
      paintNodeTree({ctx, transform: [[scale, 0, x], [0, scale, y]], scale}, doc, [id], {images: this.services.images, fonts: this.services.fonts, paintHiddenRoots: true});
    } catch {
      // A broken node leaves an empty tile rather than an error in the panel.
    }
  }
}

function copy(from: HTMLCanvasElement, to: HTMLCanvasElement) {
  const ctx = to.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, to.width, to.height);
  ctx.drawImage(from, 0, 0);
}
