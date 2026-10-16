import type {NodeId, Vec} from '../../../../shared/design/types';
import type {CommandContext} from '../../engine/commands/registry';
import {currentViewport} from '../../engine/store';
import {screenToPage, viewportCenter} from '../../engine/viewport';
import type {EditorServices} from '../../editor/services';

// What the left panel needs to know about the canvas next to it: its size (to insert at the
// viewport's centre, to run view commands), the page point under a screen point (a component dropped
// from the assets), and a command context when the editor did not hand one over.

/** The canvas element of the editor `from` sits in (the first editor on the page otherwise). */
export function canvasElement(from?: Element | null): HTMLElement | null {
  const editor = from?.closest('.dz-editor') ?? document.querySelector('.dz-editor');
  return editor?.querySelector<HTMLElement>('.dz-canvas') ?? editor?.querySelector<HTMLElement>('.dz-canvas-area') ?? null;
}

export function canvasSize(from?: Element | null): {width: number; height: number} {
  const rect = canvasElement(from)?.getBoundingClientRect();
  return rect ? {width: rect.width, height: rect.height} : {width: window.innerWidth, height: window.innerHeight};
}

/** The page point at the centre of the canvas. */
export function viewportCentre(services: EditorServices, from?: Element | null): Vec {
  return viewportCenter(currentViewport(services.store.getState()), canvasSize(from));
}

/** The page point under a screen point, or null when the point is not over the canvas. */
export function pagePointAt(services: EditorServices, clientX: number, clientY: number, from?: Element | null): Vec | null {
  const element = canvasElement(from);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  return screenToPage(currentViewport(services.store.getState()), {x: clientX - rect.left, y: clientY - rect.top});
}

/** A command context for menus opened in the panel: the store, the canvas size and the spatial index. */
export function panelCommandContext(services: EditorServices, from?: Element | null): CommandContext {
  return {
    store: services.store,
    canvasSize: () => canvasSize(from),
    index: () => {
      const {doc, pageId} = services.store.getState();
      return services.renderer()?.indexFor(doc, pageId) ?? null;
    },
  };
}

/** The spatial index of the current page when the renderer keeps one. */
export function currentIndex(services: EditorServices) {
  const {doc, pageId} = services.store.getState();
  return services.renderer()?.indexFor(doc, pageId) ?? null;
}

/** Selects a layer chosen in a panel the way a deep pick on the canvas does: its parent becomes the context. */
export function selectFromPanel(services: EditorServices, ids: readonly NodeId[], focus?: NodeId) {
  const {store} = services;
  store.setSelection(ids);
  const doc = store.getState().doc;
  const parentId = focus ? doc.nodes[focus]?.parentId : null;
  const parent = parentId ? doc.nodes[parentId] : undefined;
  store.setContext(parent && parent.type !== 'PAGE' && parent.type !== 'SECTION' ? parent.id : null);
}
