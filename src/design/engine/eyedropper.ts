import type {RGB, Vec} from '../../../shared/design/types';
import type {DesignStore} from './store';
import {registerTool} from './tools/registry';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent} from './tools/types';

// "Eyedropper" (I): picks a colour from the screen. Browsers with the EyeDropper API get the system
// picker (it samples anything on screen); elsewhere a canvas tool samples the rendered scene under
// the pointer, with a magnified loupe as in Figma. The colour goes to whoever asked: the open colour
// picker, or the fills of the selection (the "edit.pick-color" command, paint/index.ts).

export const EYEDROPPER_TOOL = 'eyedropper';

type EyeDropperResult = {sRGBHex: string};
type EyeDropperLike = {open(options?: {signal?: AbortSignal}): Promise<EyeDropperResult>};
type EyeDropperConstructor = new () => EyeDropperLike;

export const hasNativeEyeDropper = () => typeof window !== 'undefined' && typeof (window as unknown as {EyeDropper?: unknown}).EyeDropper === 'function';

/** "#0d99ff" → channels, null for anything else. */
export function parseSrgbHex(text: string): RGB | null {
  const match = /^#?([0-9a-f]{6})/i.exec(text.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return {r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255};
}

// ── Pending pick ────────────────────────────────────────────────────────────────────────────────

let pending: {resolve: (color: RGB | null) => void; store: DesignStore; previousTool: string} | null = null;

function finish(color: RGB | null) {
  const current = pending;
  if (!current) return;
  pending = null;
  const {store, previousTool} = current;
  if (store.getState().tool === EYEDROPPER_TOOL) store.setTool(previousTool === EYEDROPPER_TOOL ? 'move' : previousTool);
  current.resolve(color);
}

/** Picks a colour: the system picker when the browser has one (and `canvasOnly` is not set),
 *  otherwise the canvas sampler. Null when cancelled (Escape, another tool). Call it from a click or
 *  key handler: the system picker needs the user's gesture. */
export function pickColor(store: DesignStore, options: {canvasOnly?: boolean} = {}): Promise<RGB | null> {
  finish(null);
  if (!options.canvasOnly && hasNativeEyeDropper()) {
    const Picker = (window as unknown as {EyeDropper: EyeDropperConstructor}).EyeDropper;
    return new Picker().open().then(result => parseSrgbHex(result.sRGBHex), () => null);
  }
  registerEyedropperTool();
  return new Promise(resolve => {
    pending = {resolve, store, previousTool: store.getState().tool};
    store.setTool(EYEDROPPER_TOOL);
  });
}

export const isPickingColor = () => !!pending;

/** Cancels a pick in progress (its asker went away). */
export const cancelPick = () => finish(null);

// ── Where the colour goes ───────────────────────────────────────────────────────────────────────

let receiver: ((color: RGB) => void) | null = null;

/** The open colour picker takes picked colours while it is open; returns the release. */
export function setColorReceiver(take: ((color: RGB) => void) | null): () => void {
  receiver = take;
  return () => {
    if (receiver === take) receiver = null;
  };
}

export const colorReceiver = () => receiver;

// ── Sampling the scene ──────────────────────────────────────────────────────────────────────────

/** Pixels on each side of the centre the loupe shows (an 11 × 11 grid). */
const LOUPE_RADIUS_PX = 5;
const LOUPE_CELL = 10;

/** The scene canvas under the overlay the tool draws on (CanvasView renders the two side by side). */
function sceneCanvasNear(overlay: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const fromOverlay = overlay?.parentElement?.querySelector<HTMLCanvasElement>('canvas.dz-canvas__scene');
  if (fromOverlay) return fromOverlay;
  return typeof document !== 'undefined' ? document.querySelector<HTMLCanvasElement>('canvas.dz-canvas__scene') : null;
}

export type Sample = {color: RGB; pixels: ImageData | null};

let probe: {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} | null = null;

/** Reads the colour at a CSS-px point of the scene, with the loupe's neighbourhood. The pixels are
 *  copied into a small canvas of our own that is made for reading, so the scene keeps its GPU path. */
export function sampleScene(scene: HTMLCanvasElement, at: Vec): Sample | null {
  const dpr = scene.width / Math.max(1, scene.clientWidth || scene.width);
  const x = Math.floor(at.x * dpr), y = Math.floor(at.y * dpr);
  if (x < 0 || y < 0 || x >= scene.width || y >= scene.height) return null;
  const size = LOUPE_RADIUS_PX * 2 + 1;
  if (!probe) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (!ctx) return null;
    probe = {canvas, ctx};
  }
  let pixels: ImageData;
  try {
    probe.ctx.clearRect(0, 0, size, size);
    probe.ctx.drawImage(scene, x - LOUPE_RADIUS_PX, y - LOUPE_RADIUS_PX, size, size, 0, 0, size, size);
    pixels = probe.ctx.getImageData(0, 0, size, size);
  } catch {
    return null;
  }
  const i = (LOUPE_RADIUS_PX * size + LOUPE_RADIUS_PX) * 4;
  return {color: {r: pixels.data[i] / 255, g: pixels.data[i + 1] / 255, b: pixels.data[i + 2] / 255}, pixels};
}

const hexOf = (color: RGB) => '#' + [color.r, color.g, color.b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

export class EyedropperTool implements Tool {
  readonly id = EYEDROPPER_TOOL;
  readonly cursor = 'crosshair';
  private overlay: HTMLCanvasElement | null = null;
  private pointer: Vec | null = null;
  private sample: Sample | null = null;
  private loupe: HTMLCanvasElement | null = null;

  overlayHints() {
    return {handles: false, hover: false, sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
    ctx.setCursor(null);
  }

  deactivate() {
    this.pointer = null;
    this.sample = null;
    // Switching tools cancels a pick in progress.
    if (pending) finish(null);
  }

  private read(at: Vec): Sample | null {
    const scene = sceneCanvasNear(this.overlay);
    return scene ? sampleScene(scene, at) : null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.pointer = e.screen;
    this.sample = this.read(e.screen);
    // The loupe stands in for the pointer while it shows.
    ctx.setCursor(this.sample?.pixels ? 'none' : null);
    ctx.requestOverlay();
  }

  onPointerDown(e: ToolPointerEvent) {
    if (e.button !== 0) return;
    const sample = this.read(e.screen);
    finish(sample?.color ?? null);
  }

  onPointerCancel() {
    finish(null);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.code === 'Escape') {
      finish(null);
      return true;
    }
    return false;
  }

  drawOverlay(c: CanvasRenderingContext2D) {
    this.overlay = c.canvas instanceof HTMLCanvasElement ? c.canvas : null;
    const at = this.pointer, sample = this.sample;
    if (!at || !sample?.pixels) return;
    const size = LOUPE_RADIUS_PX * 2 + 1;
    this.loupe ??= document.createElement('canvas');
    if (this.loupe.width !== size) this.loupe.width = this.loupe.height = size;
    this.loupe.getContext('2d')?.putImageData(sample.pixels, 0, 0);
    const diameter = size * LOUPE_CELL;
    const r = diameter / 2;
    c.save();
    // The loupe: magnified pixels in a circle centred on the pointer, the sampled pixel outlined.
    c.beginPath();
    c.arc(at.x, at.y, r, 0, Math.PI * 2);
    c.shadowColor = 'rgba(0, 0, 0, 0.3)';
    c.shadowBlur = 12;
    c.shadowOffsetY = 2;
    c.fillStyle = '#FFFFFF';
    c.fill();
    c.restore();
    c.save();
    c.beginPath();
    c.arc(at.x, at.y, r - 1, 0, Math.PI * 2);
    c.clip();
    c.imageSmoothingEnabled = false;
    c.drawImage(this.loupe, at.x - r, at.y - r, diameter, diameter);
    c.strokeStyle = 'rgba(128, 128, 128, 0.25)';
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 1; k < size; k++) {
      c.moveTo(at.x - r + k * LOUPE_CELL + 0.5, at.y - r);
      c.lineTo(at.x - r + k * LOUPE_CELL + 0.5, at.y + r);
      c.moveTo(at.x - r, at.y - r + k * LOUPE_CELL + 0.5);
      c.lineTo(at.x + r, at.y - r + k * LOUPE_CELL + 0.5);
    }
    c.stroke();
    c.restore();
    c.save();
    c.lineWidth = 2;
    c.strokeStyle = '#FFFFFF';
    c.beginPath();
    c.arc(at.x, at.y, r - 1, 0, Math.PI * 2);
    c.stroke();
    const half = LOUPE_CELL / 2;
    c.strokeStyle = '#000000';
    c.lineWidth = 1;
    c.strokeRect(Math.round(at.x - half) - 0.5, Math.round(at.y - half) - 0.5, LOUPE_CELL + 1, LOUPE_CELL + 1);
    c.strokeStyle = '#FFFFFF';
    c.strokeRect(Math.round(at.x - half) + 0.5, Math.round(at.y - half) + 0.5, LOUPE_CELL - 1, LOUPE_CELL - 1);
    // The hex under the loupe.
    const text = hexOf(sample.color);
    c.font = '500 11px "Inter Variable", Inter, system-ui, sans-serif';
    const width = c.measureText(text).width + 12;
    const x = Math.round(at.x - width / 2), y = Math.round(at.y + r + 8);
    c.fillStyle = '#1E1E1E';
    c.beginPath();
    c.roundRect(x, y, width, 20, 5);
    c.fill();
    c.fillStyle = '#FFFFFF';
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    c.fillText(text, at.x, y + 10.5);
    c.restore();
  }
}

let registered = false;
export function registerEyedropperTool() {
  if (registered) return;
  registered = true;
  registerTool(EYEDROPPER_TOOL, () => new EyedropperTool());
}
