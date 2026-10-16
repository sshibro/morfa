import type {DesignDocument, ImageFilters, ImageRef, NodeId, Paint} from '../../../shared/design/types';
import type {ImageCache} from './contracts';
import {applyImageFilters, filtersKey, mipLevel, neutralFilters} from './render/image-math';
import type {AnyCanvas} from './render/canvas';
import {context2d, createCanvas} from './render/canvas';

// Decoded pictures of design files (docs/design-tool.md §Client engine). A picture is fetched from
// its same-origin /uploads URL with the session cookie, decoded once with createImageBitmap and kept
// in a least-recently-used cache bounded by decoded bytes. Zoomed-out drawing reads half-size levels
// (mips) made on first need, so a 6000 px photo shown 200 px wide is neither resampled from 36 MP
// every frame nor shimmering; colour adjustments are applied once per level and filter set.
// Over the budget, a picture only drawn as its mips lately gives up its full-size decode first (the
// mips stay, made from it, so they draw the same); drawing it at full size again decodes it again,
// showing its finest mip meanwhile. Only then are whole pictures dropped, least recently used first:
// sixty large photos seen zoomed out fit, instead of being dropped and fetched again in a loop.

export type ImageSource = {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Natural px per source px (2^level for mips). */
  factor: number;
  /** A coarser level shown while the full-size picture is decoded again: draw it, but draw again
   *  once `status` stops saying 'loading'. */
  interim?: boolean;
};

export interface DesignImageCache extends ImageCache {
  /** What to draw when the picture lands at `scale` device px per natural px, with `filters`
   *  applied. Null while loading or after a failure. */
  source(ref: ImageRef, doc: DesignDocument, scale: number, filters?: ImageFilters): ImageSource | null;
  status(ref: ImageRef, doc: DesignDocument): 'missing' | 'loading' | 'ready' | 'failed';
  /** Drops every decoded picture (closing the file or freeing memory). */
  dispose(): void;
}

/** Pictures are drawn only from the app's own origin, from blob: URLs this tab made, or from inline
 *  data:image URLs (a portable file being opened). Anything else is never fetched. */
export function isAllowedImageUrl(url: string, origin = typeof location !== 'undefined' ? location.origin : ''): boolean {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('blob:')) return !origin || url.startsWith(`blob:${origin}/`);
  if (/^data:image\/(png|jpe?g|webp|gif|avif|bmp);/i.test(url)) return true;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    return !!origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Least-recently-used map with a byte budget. Pure; `onEvict` releases what an entry holds. Over the
 *  budget, `shed` may first make entries smaller (least recently used first; it returns the bytes the
 *  entry holds now, or null to leave it), and only then are entries evicted. */
export class ByteLru<K, V> {
  private readonly map = new Map<K, {value: V; bytes: number}>();
  private total = 0;
  constructor(
    private readonly budget: number,
    private readonly onEvict: (key: K, value: V) => void = () => {},
    private readonly shed: (key: K, value: V) => number | null = () => null,
  ) {}

  get bytes() { return this.total; }
  get size() { return this.map.size; }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: K) { return this.map.has(key); }

  /** Inserts or updates; evicts the least recently used entries (never `key` itself) over budget. */
  set(key: K, value: V, bytes: number): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.bytes;
      this.map.delete(key);
    }
    this.map.set(key, {value, bytes});
    this.total += bytes;
    this.trim(key);
  }

  /** Changes the bytes an entry holds (a new mip was made) and trims. */
  resize(key: K, bytes: number): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.total += bytes - entry.bytes;
    entry.bytes = bytes;
    this.trim(key);
  }

  delete(key: K): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.bytes;
    this.onEvict(key, entry.value);
  }

  clear(): void {
    for (const key of [...this.map.keys()]) this.delete(key);
  }

  private trim(keep: K): void {
    if (this.total <= this.budget) return;
    for (const [key, entry] of this.map) {
      if (this.total <= this.budget) return;
      if (key === keep) continue;
      const bytes = this.shed(key, entry.value);
      if (bytes === null || bytes >= entry.bytes) continue;
      this.total += bytes - entry.bytes;
      entry.bytes = bytes;
    }
    for (const key of this.map.keys()) {
      if (this.total <= this.budget) break;
      if (key === keep) continue;
      this.delete(key);
    }
  }
}

type Entry = {
  url: string;
  state: 'loading' | 'ready' | 'failed';
  bitmap: ImageBitmap | null;
  width: number;
  height: number;
  /** mips[k - 1] is level k (1/2^k of the natural size). */
  mips: AnyCanvas[];
  filtered: Map<string, AnyCanvas>;
  promise: Promise<void>;
  /** The full-size decode is not shed before this time: it was asked for (drawn at level 0, `get`; for
   *  longer by `whenReady`, which an export paints right after). */
  holdUntil: number;
  /** The full-size decode being made again after it was shed. */
  reload: Promise<void> | null;
  /** That failed: the mips are all there is. */
  reloadFailed: boolean;
};

/** A full-size decode asked for within this long is never shed (it would be decoded again at once). */
const FULL_HOLD_MS = 3000;
/** After `whenReady`, while an export paints. */
const EXPORT_HOLD_MS = 60_000;
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const bytesOf = (entry: Entry) => {
  let bytes = entry.bitmap ? entry.width * entry.height * 4 : 0;
  for (const mip of entry.mips) bytes += mip.width * mip.height * 4;
  for (const copy of entry.filtered.values()) bytes += copy.width * copy.height * 4;
  return bytes;
};

/** Every picture a subtree draws: image fills and strokes, and image fills of text runs. */
export function imageRefsUnder(doc: DesignDocument, rootId: NodeId): Set<ImageRef> {
  const refs = new Set<ImageRef>();
  const add = (paints: readonly Paint[] | undefined) => {
    for (const paint of paints ?? []) if (paint.type === 'IMAGE' && paint.visible !== false && paint.imageRef) refs.add(paint.imageRef);
  };
  const stack = [rootId];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    add(node.fills);
    add(node.strokes);
    for (const run of node.text?.runs ?? []) add(run.fills);
    if (node.children) stack.push(...node.children);
  }
  return refs;
}

async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (error) {
    // SVG and a few other formats decode only through an <img> (main thread).
    if (typeof Image === 'undefined' || typeof URL === 'undefined') throw error;
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await image.decode();
      return await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, {credentials: 'same-origin', signal});
  if (!response.ok) throw new Error(`image ${response.status}`);
  return decodeBlob(await response.blob());
}

export type ImageCacheOptions = {
  /** Decoded bytes kept before the least recently used pictures are dropped (default 512 MB). */
  budgetBytes?: number;
  /** Fetches and decodes one URL (tests and the raster worker inject their own). */
  load?: (url: string, signal: AbortSignal) => Promise<ImageBitmap>;
  maxConcurrent?: number;
};

export function createImageCache(options: ImageCacheOptions = {}): DesignImageCache {
  const load = options.load ?? fetchBitmap;
  const maxConcurrent = options.maxConcurrent ?? 6;
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const entries = new ByteLru<string, Entry>(options.budgetBytes ?? 512 * 1024 * 1024, (_, entry) => {
    entry.bitmap?.close();
    for (const mip of entry.mips) mip.width = mip.height = 0;
    for (const copy of entry.filtered.values()) copy.width = copy.height = 0;
    entry.bitmap = null;
  }, (_, entry) => shed(entry));
  const queue: (() => void)[] = [];
  let running = 0;
  let notifyScheduled = false;

  const notify = () => {
    if (notifyScheduled) return;
    notifyScheduled = true;
    // One notification for a burst of pictures arriving together.
    queueMicrotask(() => {
      notifyScheduled = false;
      for (const listener of [...listeners]) listener();
    });
  };

  const pump = () => {
    while (running < maxConcurrent && queue.length) {
      running++;
      queue.shift()!();
    }
  };

  const urlOf = (ref: ImageRef, doc: DesignDocument) => {
    const url = doc.images[ref]?.url;
    return url && isAllowedImageUrl(url) ? url : null;
  };

  /** Fetches and decodes `url` in its turn (at most `maxConcurrent` at once). */
  function decode(url: string): Promise<ImageBitmap> {
    return new Promise<ImageBitmap>((resolve, reject) => {
      queue.push(() => {
        load(url, abort.signal)
          .then(resolve, reject)
          .finally(() => {
            running--;
            pump();
          });
      });
      pump();
    });
  }

  function start(url: string): Entry {
    const existing = entries.get(url);
    if (existing) return existing;
    const entry: Entry = {url, state: 'loading', bitmap: null, width: 0, height: 0, mips: [], filtered: new Map(), promise: Promise.resolve(), holdUntil: 0, reload: null, reloadFailed: false};
    entry.promise = decode(url)
      .then(bitmap => {
        entry.bitmap = bitmap;
        entry.width = bitmap.width;
        entry.height = bitmap.height;
        entry.state = 'ready';
        if (entries.has(url)) entries.resize(url, bytesOf(entry));
      })
      .catch(() => {
        entry.state = 'failed';
      })
      .finally(() => {
        if (!abort.signal.aborted) notify();
      });
    entries.set(url, entry, 0);
    return entry;
  }

  /** Gives up the full-size decode of a picture drawn only as its mips lately: the bytes it holds then,
   *  or null when it has nothing to give (no mips yet, or the full size is in use). */
  function shed(entry: Entry): number | null {
    if (entry.state !== 'ready' || !entry.bitmap || !entry.mips.length || clock() < entry.holdUntil) return null;
    entry.bitmap.close();
    entry.bitmap = null;
    for (const [key, copy] of entry.filtered) {
      if (!key.startsWith('0:')) continue;
      copy.width = copy.height = 0;
      entry.filtered.delete(key);
    }
    return bytesOf(entry);
  }

  /** Decodes a shed picture again; false when that already failed (its mips are then all there is). */
  function reload(entry: Entry): boolean {
    if (entry.reloadFailed) return false;
    if (!entry.reload) {
      entry.reload = decode(entry.url)
        .then(
          bitmap => {
            entry.bitmap = bitmap;
            if (entries.has(entry.url)) entries.resize(entry.url, bytesOf(entry));
          },
          () => {
            entry.reloadFailed = true;
          },
        )
        .finally(() => {
          entry.reload = null;
          if (!abort.signal.aborted) notify();
        });
    }
    return true;
  }

  function hold(entry: Entry, ms: number): void {
    entry.holdUntil = Math.max(entry.holdUntil, clock() + ms);
  }

  function mip(entry: Entry, level: number): AnyCanvas | ImageBitmap | null {
    if (level <= 0) return entry.bitmap;
    if (entry.mips.length < level) {
      if (!entry.bitmap && !entry.mips.length) return null;
      while (entry.mips.length < level) {
        const k = entry.mips.length + 1;
        const from = k === 1 ? entry.bitmap! : entry.mips[k - 2];
        const canvas = createCanvas(Math.max(1, entry.width >> k), Math.max(1, entry.height >> k));
        const ctx = context2d(canvas);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(from, 0, 0, canvas.width, canvas.height);
        entry.mips.push(canvas);
      }
      entries.resize(entry.url, bytesOf(entry));
    }
    return entry.mips[level - 1];
  }

  function filtered(entry: Entry, level: number, filters: ImageFilters): AnyCanvas | null {
    const key = `${level}:${filtersKey(filters)}`;
    let copy = entry.filtered.get(key);
    if (copy) return copy;
    const from = mip(entry, level);
    if (!from) return null;
    copy = createCanvas(from.width, from.height);
    const ctx = context2d(copy, {willReadFrequently: true});
    ctx.drawImage(from, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height);
    applyImageFilters(pixels.data, filters);
    ctx.putImageData(pixels, 0, 0);
    entry.filtered.set(key, copy);
    entries.resize(entry.url, bytesOf(entry));
    return copy;
  }

  const cache: DesignImageCache = {
    get(ref, doc) {
      const url = urlOf(ref, doc);
      if (!url) return null;
      const entry = start(url);
      if (entry.state !== 'ready') return null;
      hold(entry, FULL_HOLD_MS);
      if (!entry.bitmap) reload(entry);
      return entry.bitmap;
    },
    size(ref, doc) {
      const url = urlOf(ref, doc);
      const entry = url ? entries.get(url) : undefined;
      if (entry?.state === 'ready') return {width: entry.width, height: entry.height};
      const asset = doc.images[ref];
      return asset && asset.width > 0 && asset.height > 0 ? {width: asset.width, height: asset.height} : null;
    },
    source(ref, doc, scale, filters) {
      const url = urlOf(ref, doc);
      if (!url) return null;
      const entry = start(url);
      if (entry.state !== 'ready' || (!entry.bitmap && !entry.mips.length)) return null;
      let level = mipLevel(scale, entry.width, entry.height);
      let interim = false;
      if (level === 0) {
        hold(entry, FULL_HOLD_MS);
        if (!entry.bitmap) {
          // Shed: its finest mip stands in until the full size is decoded again.
          interim = reload(entry);
          level = 1;
        }
      }
      const source = filters && !neutralFilters(filters) ? filtered(entry, level, filters) : mip(entry, level);
      if (!source) return null;
      return {source, width: source.width, height: source.height, factor: entry.width / source.width, ...(interim ? {interim} : {})};
    },
    status(ref, doc) {
      const url = urlOf(ref, doc);
      if (!url) return 'missing';
      const entry = entries.get(url);
      return entry?.reload ? 'loading' : entry?.state ?? 'loading';
    },
    async whenReady(doc, rootId) {
      const pending: Promise<unknown>[] = [];
      for (const ref of imageRefsUnder(doc, rootId)) {
        const url = urlOf(ref, doc);
        if (!url) continue;
        const entry = start(url);
        // An export paints at full size right after: keep it, or decode it again if it was shed.
        hold(entry, EXPORT_HOLD_MS);
        pending.push(entry.promise.then(() => (entry.state === 'ready' && !entry.bitmap && reload(entry) ? entry.reload : undefined)));
      }
      await Promise.all(pending);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      abort.abort();
      queue.length = 0;
      entries.clear();
      listeners.clear();
    },
  };
  return cache;
}

/** True when `images` is this module's cache (mips and filters); the renderer also accepts a bare
 *  ImageCache, drawing full-size pictures without colour adjustments. */
export const isDesignImageCache = (images: ImageCache): images is DesignImageCache => typeof (images as DesignImageCache).source === 'function';
