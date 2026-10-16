import type {Guide, NodeId} from '../../../shared/design/types';
import type {Transaction} from '../../../shared/design/transaction';
import type {Command} from './commands/registry';
import type {Viewport} from './contracts';
import type {DesignStore} from './store';

// Rulers and guides (⇧R): the maths behind src/design/editor/Rulers.tsx. Rulers show page
// coordinates along the top and left edges of the canvas in screen space; dragging out of one makes
// a guide (stored on the page, `page.guides`, so it is saved and undone like any edit), dragging a
// guide moves it and dropping it back on a ruler removes it. Guides are snap targets (snapping.ts).

/** Thickness of a ruler, CSS px. */
export const RULER_SIZE = 20;
/** Labelled ticks stand at least this far apart on screen. */
const MIN_TICK_PX = 50;
const NICE_STEPS = [1, 2, 5] as const;

/** Page units between labelled ticks at `zoom`: 1, 2, 5, 10, 20, 50… whichever is first wide enough. */
export function rulerStep(zoom: number, minPx = MIN_TICK_PX): number {
  for (let exp = 0; exp < 10; exp++) {
    for (const n of NICE_STEPS) {
      const step = n * 10 ** exp;
      if (step * zoom >= minPx) return step;
    }
  }
  return 10 ** 10;
}

/** The labelled ticks of a ruler that starts at page coordinate `start` and is `length` CSS px long:
 *  each tick's screen offset and page value. */
export function rulerTicks(start: number, zoom: number, length: number, step = rulerStep(zoom)): {offset: number; value: number}[] {
  const out: {offset: number; value: number}[] = [];
  const end = start + length / zoom;
  for (let value = Math.ceil(start / step) * step; value <= end; value += step) out.push({offset: (value - start) * zoom, value: Object.is(value, -0) ? 0 : value});
  return out;
}

/** Screen offset (CSS px from the canvas's left or top) of a guide. */
export const guideOffset = (guide: Guide, viewport: Viewport) => (guide.axis === 'X' ? (guide.offset - viewport.x) * viewport.zoom : (guide.offset - viewport.y) * viewport.zoom);

/** The guide under a screen point, within `reach` CSS px; null if none. */
export function guideAt(guides: readonly Guide[], screen: {x: number; y: number}, viewport: Viewport, reach = 3): number | null {
  let best: number | null = null, distance = Infinity;
  guides.forEach((guide, index) => {
    const d = Math.abs(guideOffset(guide, viewport) - (guide.axis === 'X' ? screen.x : screen.y));
    if (d <= reach && d < distance) {
      best = index;
      distance = d;
    }
  });
  return best;
}

/** The guides with the one at `index` replaced by `guide` (appended when `index` is past the end) or removed (null). */
export function withGuide(guides: readonly Guide[], index: number, guide: Guide | null): Guide[] {
  const next = [...guides];
  if (guide && index >= next.length) next.push(guide);
  else if (guide) next[index] = guide;
  else if (index < next.length) next.splice(index, 1);
  return next;
}

/** Writes a page's guides (a page node takes a plain update). */
export function setGuides(tx: Transaction, pageId: NodeId, guides: readonly Guide[]) {
  tx.update(pageId, {guides: guides.map(guide => ({axis: guide.axis, offset: guide.offset}))});
}

/** A guide's page position from a pointer, on whole pixels when the editor snaps to pixels. */
export const guidePosition = (value: number, pixel: boolean) => (pixel ? Math.round(value) : Math.round(value * 100) / 100);

const canvasSizes = new WeakMap<DesignStore, () => {width: number; height: number}>();

/** Tells panels the canvas's size (the overlay over the canvas measures it), for "the middle of the view". */
export function bindCanvasSize(store: DesignStore, read: () => {width: number; height: number}): () => void {
  canvasSizes.set(store, read);
  return () => {
    if (canvasSizes.get(store) === read) canvasSizes.delete(store);
  };
}

/** The canvas's CSS size, or null before the overlay has measured it. */
export const canvasSizeOf = (store: DesignStore) => canvasSizes.get(store)?.() ?? null;

export const RULER_COMMANDS: Command[] = [
  {
    id: 'view.rulers',
    label: 'Rulers',
    group: 'view',
    shortcut: {code: 'KeyR', shift: true},
    run: ctx => ctx.store.setUI({rulers: !ctx.store.getState().ui.rulers}),
    checked: ctx => ctx.store.getState().ui.rulers,
  },
];
