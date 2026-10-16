import {createNode} from '../../shared/design/defaults';
import {TransactionError, type Transaction} from '../../shared/design/transaction';
import {CONTAINER_TYPES, type DesignDocument, type NodeId} from '../../shared/design/types';
import type {Rng} from './design-fuzz';

// Random edits through a transaction's own methods (update, create, move, reorder, remove), for the tests of the node table
// written in place: tests/design-transaction-inverse.test.ts and tests/design-table-in-place.test.ts.

function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)];
}

function isDescendant(doc: DesignDocument, id: NodeId, ancestor: NodeId): boolean {
  for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) if (node.parentId === ancestor) return true;
  return false;
}

/** One random edit through the transaction's own methods (the writes a user's commit makes, not a patch applied). */
export function randomRecipe(r: Rng, fresh: () => NodeId): (tx: Transaction) => void {
  return tx => {
    const steps = 1 + Math.floor(r() * 4);
    for (let i = 0; i < steps; i++) {
      const doc = tx.doc;
      const ids = Object.keys(doc.nodes);
      const layers = ids.filter(id => doc.nodes[id].type !== 'PAGE');
      const containers = ids.filter(id => CONTAINER_TYPES.includes(doc.nodes[id].type) && doc.nodes[id].type !== 'INSTANCE');
      try {
        switch (Math.floor(r() * 7)) {
          case 0:
          case 1: {
            const id = pick(r, layers);
            tx.update(id, {x: Math.round(r() * 400), y: Math.round(r() * 400)});
            break;
          }
          case 2: {
            const id = pick(r, layers);
            tx.update(id, {width: 10 + Math.round(r() * 300), height: 10 + Math.round(r() * 200), name: `n${Math.floor(r() * 1000)}`});
            break;
          }
          case 3: {
            const id = pick(r, layers);
            tx.update(id, {opacity: Math.round(r() * 100) / 100, visible: r() > 0.2, rotation: Math.round(r() * 360)});
            break;
          }
          case 4: {
            const parent = pick(r, containers);
            const id = fresh();
            const type = pick(r, ['RECTANGLE', 'FRAME', 'TEXT', 'ELLIPSE'] as const);
            tx.create(createNode(type, {id, name: id, x: Math.round(r() * 200), y: Math.round(r() * 200), width: 40, height: 30}), parent, Math.floor(r() * ((doc.nodes[parent].children?.length ?? 0) + 1)));
            break;
          }
          case 5: {
            const id = pick(r, layers);
            const target = pick(r, containers);
            if (target !== id && !isDescendant(doc, target, id)) tx.move(id, target, Math.floor(r() * ((doc.nodes[target].children?.length ?? 0) + 1)), {keepWorld: r() > 0.5});
            break;
          }
          case 6: {
            const id = pick(r, layers);
            if (r() > 0.5) tx.remove(id);
            else tx.reorder(id, Math.floor(r() * ((doc.nodes[doc.nodes[id].parentId!]?.children?.length ?? 1))));
            break;
          }
        }
      } catch (error) {
        // An edit the model refuses (a layer inside an instance, a locked structure): the recipe goes on with the next.
        if (!(error instanceof TransactionError)) throw error;
      }
    }
  };
}

