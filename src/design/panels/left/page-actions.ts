import type {NodeId} from '../../../../shared/design/types';
import {createNode, newId} from '../../../../shared/design/defaults';
import {nextNumberedName} from '../../../../shared/design/tree';
import type {DesignStore} from '../../engine/store';
import {cloneSubtrees, insertClones} from '../../engine/clipboard';

// What the pages list does to the file, each as one undo step.

/** Adds "Page N" at the end of the list, switches to it and returns its id. */
export function addPage(store: DesignStore): NodeId {
  const {doc} = store.getState();
  const id = newId();
  const name = nextNumberedName('Page', doc.pages.map(page => doc.nodes[page]?.name ?? ''));
  store.transact('New page', tx => tx.addPage(createNode('PAGE', {id, name})));
  store.setPage(id);
  return id;
}

/** "Duplicate page": the page and everything on it with fresh ids, right after the original. */
export function duplicatePage(store: DesignStore, pageId: NodeId): NodeId | null {
  const {doc} = store.getState();
  const page = doc.nodes[pageId];
  if (!page) return null;
  const id = newId();
  const names = doc.pages.map(each => doc.nodes[each]?.name ?? '');
  let name = `${page.name} (copy)`;
  for (let n = 2; names.includes(name); n++) name = `${page.name} (copy ${n})`;
  const {nodes, ids} = cloneSubtrees(doc.nodes, page.children ?? []);
  store.transact('Duplicate page', tx => {
    const copy = {...page, id, name, children: [], flowStartingPoints: (page.flowStartingPoints ?? []).filter(flow => ids.has(flow.nodeId)).map(flow => ({...flow, nodeId: ids.get(flow.nodeId)!}))};
    tx.addPage(copy, doc.pages.indexOf(pageId) + 1);
    insertClones(tx, nodes, () => ({parentId: id}));
    for (const [from, to] of ids) {
      const modes = doc.variableModes?.[from];
      if (modes) tx.setVariableModes(to, modes);
    }
  });
  store.setPage(id);
  return id;
}

/** Moves a page so it ends up before the page now at `boundary` (0..pages.length). */
export function movePage(store: DesignStore, pageId: NodeId, boundary: number): boolean {
  const order = store.getState().doc.pages;
  const from = order.indexOf(pageId);
  if (from < 0 || boundary === from || boundary === from + 1) return false;
  const next = order.filter(id => id !== pageId);
  next.splice(boundary > from ? boundary - 1 : boundary, 0, pageId);
  store.transact('Reorder pages', tx => tx.setPages(next));
  return true;
}

/** Whether a page is a divider in the pages list, as Figma's: an empty page whose name starts with "-". */
export const isPageDivider = (name: string, empty: boolean) => empty && /^\s*-/.test(name);
