import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {defaultVariant, wouldCreateCycle} from '../../../../shared/design/components';
import {frameAtPoint, pageIdOf} from '../../../../shared/design/tree';
import {insertInstance} from '../../engine/commands/components';
import type {EditorServices} from '../../editor/services';
import {currentIndex} from './panel-context';

// What the assets panel does with a component: place an instance (a click puts it at the centre of
// the view, a drop where it lands, inside the frame under that point) and show the main component.
// Instances are made by the component feature's `insertInstance` (engine/commands/components.ts), so
// there is one way an instance comes to be; this only decides where.

/** Whether an instance of `componentId` may go into `parentId`: not into an instance or a copy, not
 *  into a variant set, never into its own component (directly or through others). */
export function canHoldInstance(doc: DesignDocument, componentId: NodeId, parentId: NodeId): boolean {
  const target = doc.nodes[parentId];
  if (!target?.children || target.type === 'INSTANCE' || target.mainId !== undefined || target.type === 'COMPONENT_SET') return false;
  const main = doc.nodes[componentId]?.type === 'COMPONENT_SET' ? defaultVariant(doc, componentId) : componentId;
  return !!main && !wouldCreateCycle(doc, main, parentId);
}

/** Places an instance of the component (a set gives its default variant) centred on `point`, inside
 *  the top-most frame there when it may go in it, else on the page. Returns its id. */
export function placeInstanceAt(services: EditorServices, componentId: NodeId, point: Vec): NodeId | null {
  const {store} = services;
  const {doc, pageId} = store.getState();
  const source = doc.nodes[componentId];
  if (!source) return null;
  const main = source.type === 'COMPONENT_SET' ? doc.nodes[defaultVariant(doc, componentId) ?? ''] : source;
  if (!main) {
    services.toast('The component set has no variants', 'error');
    return null;
  }
  const frame = frameAtPoint(doc, pageId, point, new Set(), currentIndex(services));
  const parentId = frame && canHoldInstance(doc, componentId, frame) ? frame : pageId;
  const local = parentId === pageId ? point : apply(invert(worldMatrix(doc, parentId)), point);
  return insertInstance(store, componentId, {parentId, x: Math.round(local.x - main.width / 2), y: Math.round(local.y - main.height / 2)});
}

/** "Go to main component": its page, selected and in view. */
export function showMainComponent(services: EditorServices, componentId: NodeId) {
  const {store} = services;
  const {doc, pageId} = store.getState();
  const page = pageIdOf(doc, componentId);
  if (!page) return;
  if (page !== pageId) store.setPage(page);
  store.setSelection([componentId]);
  services.revealNodes([componentId]);
}
