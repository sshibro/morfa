import type {DesignStore} from '../engine/store';

// Bench-only (lane B0: scripts/bench/canvas.ts, edit-ops.ts). With `?bench=1` in the address the editor puts its store on
// `window.__morfaBench`, marks its first scene paint (`performance.mark('morfa:first-paint')`), counts scene renders and notes
// when each frame's drawing ended, so the benches time what the built editor does. Without the parameter every call here
// returns at once and nothing changes.

type BenchHost = {__morfaBench?: {store: DesignStore; renders: number; drawnAt: number; renderer?: {engine: string; reason?: string}}};

let enabled: boolean | null = null;
export function benchMode(): boolean {
  enabled ??= typeof location !== 'undefined' && /[?&]bench=1(?:&|$)/.test(location.search);
  return enabled;
}

const marked = new Set<string>();
/** `performance.mark('morfa:<name>')`, once per page. */
export function benchMark(name: string): void {
  if (!benchMode() || marked.has(name)) return;
  marked.add(name);
  performance.mark('morfa:' + name);
}

/** CanvasView finished drawing a frame (`scene`: the scene was rendered, not only the overlay). The first scene is the first
 *  paint; edit-ops counts scene renders to find the frame an edit lands in; canvas.ts reads `drawnAt` for each frame's work. */
export function benchDrawn(scene: boolean): void {
  if (!benchMode()) return;
  if (scene) benchMark('first-paint');
  const host = window as unknown as BenchHost;
  if (!host.__morfaBench) return;
  if (scene) host.__morfaBench.renders++;
  host.__morfaBench.drawnAt = performance.now();
}

/** Which scene renderer draws (`canvas2d` or `gpu`, lane L4) and why not the other, for the bench's notes. */
export function benchRenderer(engine: string, reason?: string): void {
  if (!benchMode()) return;
  const host = window as unknown as BenchHost;
  if (host.__morfaBench) host.__morfaBench.renderer = {engine, reason};
}

/** Exposes the editor's store while it is open; returns the cleanup. */
export function exposeForBench(store: DesignStore): () => void {
  if (!benchMode()) return () => {};
  benchMark('editor-ready');
  const host = window as unknown as BenchHost;
  host.__morfaBench = {store, renders: 0, drawnAt: 0};
  return () => {
    if (host.__morfaBench?.store === store) delete host.__morfaBench;
  };
}
