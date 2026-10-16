import type {NodeId, SceneNode} from '../../../shared/design/types';
import type {Transaction} from '../../../shared/design/transaction';
import {withOverrideTracking} from '../../../shared/design/components';
import {withStylesCleared} from '../../../shared/design/styles';
import type {DesignStore} from './store';

// The one door for edits a person makes by hand (panels, on-canvas handles, text editing). Two rules
// apply to them and to nothing the engine computes itself (layout, constraints, instance sync):
//   - a field typed by hand detaches the style it came from (`fillStyleId` for `fills`, ...),
//     unless the same edit sets the style id (applying a style sets both);
//   - on a copy inside an instance the field becomes an override, so syncing with the main keeps it.
// Tools that move or resize write geometry through `resizeUpdates`/`tx.update` directly: their
// descendant writes are constraint-driven, and only the node the user grabbed is tracked here.

/** Applies one hand-made edit inside an open transaction. */
export function userUpdate(tx: Transaction, id: NodeId, partial: Partial<SceneNode>): void {
  if (!tx.get(id)) return;
  tx.update(id, withOverrideTracking(tx.doc, id, withStylesCleared(partial)));
}

/** Edits each node in `ids` with the fields `make` returns (null skips the node), as one undo step.
 *  `make` sees the node as the transaction has it, so relative edits (`opacity: node.opacity / 2`) compose. */
export function editNodes(store: DesignStore, label: string, ids: readonly NodeId[], make: (node: SceneNode) => Partial<SceneNode> | null): void {
  if (!ids.length) return;
  store.transact(label, tx => {
    for (const id of ids) {
      const node = tx.get(id);
      const partial = node && make(node);
      if (partial) userUpdate(tx, id, partial);
    }
  });
}
