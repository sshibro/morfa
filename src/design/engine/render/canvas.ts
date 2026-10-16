// Canvases the renderer draws into besides the visible one: layers, silhouettes, shaders, tiles.
// OffscreenCanvas when the browser has it (also what a raster worker will use), a detached
// <canvas> otherwise.

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.ceil(width)), h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function context2d(canvas: AnyCanvas, options?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = (canvas as OffscreenCanvas).getContext('2d', options) as Ctx2D | null;
  if (!ctx) throw new Error('The browser could not draw the canvas: not enough memory for the image.');
  return ctx;
}

/** Puts a context back to the defaults a fresh one has (contexts are reused from the pool). */
export function resetContext(ctx: Ctx2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  if ('filter' in ctx) ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setLineDash([]);
}

let filterSupport: boolean | null = null;
/** Whether `ctx.filter` works (Chrome, Firefox, Safari 18+). Without it blurs run in JavaScript. */
export function supportsFilter(): boolean {
  if (filterSupport !== null) return filterSupport;
  try {
    const ctx = context2d(createCanvas(1, 1));
    ctx.filter = 'blur(1px)';
    filterSupport = ctx.filter === 'blur(1px)';
  } catch {
    filterSupport = false;
  }
  return filterSupport;
}

/** Blurs a region of a canvas in place by σ device px. Uses `ctx.filter` when it works; otherwise
 *  three box blurs over the pixels, which approximate a Gaussian within a few percent. */
export function blurCanvas(canvas: AnyCanvas, width: number, height: number, sigma: number, pool: CanvasPool): void {
  if (!(sigma > 0.05)) return;
  if (supportsFilter()) {
    const copy = pool.acquire(width, height);
    copy.ctx.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
    const ctx = context2d(canvas);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = `blur(${sigma}px)`;
    ctx.drawImage(copy.canvas, 0, 0, width, height, 0, 0, width, height);
    ctx.restore();
    pool.release(copy);
    return;
  }
  const ctx = context2d(canvas, {willReadFrequently: true});
  const image = ctx.getImageData(0, 0, width, height);
  boxBlurRGBA(image.data, width, height, sigma);
  ctx.putImageData(image, 0, 0);
}

/** Three passes of a box blur whose combined variance matches σ (premultiplies so edges do not
 *  darken). Exported for tests. */
export function boxBlurRGBA(data: Uint8ClampedArray, width: number, height: number, sigma: number): void {
  const radius = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  const buffer = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    buffer[i] = data[i] * a; buffer[i + 1] = data[i + 1] * a; buffer[i + 2] = data[i + 2] * a; buffer[i + 3] = data[i + 3];
  }
  const temp = new Float32Array(data.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(buffer, temp, width, height, radius, true);
    boxPass(temp, buffer, width, height, radius, false);
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = buffer[i + 3];
    const k = a > 0 ? 255 / a : 0;
    data[i] = buffer[i] * k; data[i + 1] = buffer[i + 1] * k; data[i + 2] = buffer[i + 2] * k; data[i + 3] = a;
  }
}

function boxPass(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean): void {
  const lines = horizontal ? height : width, length = horizontal ? width : height;
  const step = horizontal ? 4 : width * 4;
  const scale = 1 / (2 * radius + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let k = 0; k <= radius && k < length; k++) sum += src[base + k * step + channel];
      for (let i = 0; i < length; i++) {
        dst[base + i * step + channel] = sum * scale;
        const out = i - radius, inn = i + radius + 1;
        if (out >= 0) sum -= src[base + out * step + channel];
        if (inn < length) sum += src[base + inn * step + channel];
      }
    }
  }
}

export type PooledCanvas = {canvas: AnyCanvas; ctx: Ctx2D; width: number; height: number};

/** Reuses offscreen canvases between layers and frames: allocating a canvas per layer per frame
 *  would churn GPU memory. A canvas may be larger than asked; callers use the top-left
 *  `width` × `height` and draw from that source rectangle. */
export class CanvasPool {
  private free: PooledCanvas[] = [];
  private pixels = 0;
  constructor(private readonly maxPixels = 48 * 1024 * 1024) {}

  acquire(width: number, height: number): PooledCanvas {
    const w = Math.max(1, Math.ceil(width)), h = Math.max(1, Math.ceil(height));
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const item = this.free[i];
      if (item.canvas.width >= w && item.canvas.height >= h && item.canvas.width * item.canvas.height <= Math.max(4 * w * h, 256 * 256)) {
        if (best < 0 || item.canvas.width * item.canvas.height < this.free[best].canvas.width * this.free[best].canvas.height) best = i;
      }
    }
    let item: PooledCanvas;
    if (best >= 0) {
      item = this.free.splice(best, 1)[0];
      this.pixels -= item.canvas.width * item.canvas.height;
      resetContext(item.ctx);
      item.ctx.clearRect(0, 0, w, h);
    } else {
      const round = (n: number) => Math.ceil(n / 64) * 64;
      const canvas = createCanvas(round(w), round(h));
      item = {canvas, ctx: context2d(canvas), width: w, height: h};
      resetContext(item.ctx);
    }
    item.width = w;
    item.height = h;
    return item;
  }

  release(item: PooledCanvas): void {
    const size = item.canvas.width * item.canvas.height;
    if (size > this.maxPixels) return;
    this.free.push(item);
    this.pixels += size;
    while (this.pixels > this.maxPixels && this.free.length) {
      const dropped = this.free.shift()!;
      this.pixels -= dropped.canvas.width * dropped.canvas.height;
      // Shrinking releases the backing store now instead of at garbage collection.
      dropped.canvas.width = dropped.canvas.height = 1;
    }
  }

  clear(): void {
    for (const item of this.free) item.canvas.width = item.canvas.height = 1;
    this.free = [];
    this.pixels = 0;
  }
}
