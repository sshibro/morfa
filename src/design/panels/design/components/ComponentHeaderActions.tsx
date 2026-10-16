import {useCallback, type ComponentType} from 'react';
import type {DesignDocument, NodeId} from '../../../../../shared/design/types';
import {topLevelSelection} from '../../../../../shared/design/tree';
import {combinable, combineSelectionAsVariants, createComponentsFromSelection} from '../../../engine/commands/components';
import {IconButton} from '../../../ui/Button';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {IconComponent, IconVariant} from '../../../ui/icons';
import type {SectionProps, SelectionInfo} from '../sections';
import {useComponentHost, useDocValue} from './hooks';

// Quick actions for the "Design" panel's selection header: "Create component" (⌥⌘K; with several
// layers a menu adds "Create multiple components") and "Combine as variants" for two or more
// main components. Register with the header's registry when it exists:
//   registerHeaderAction(componentHeaderAction)

const REFUSED = new Set(['PAGE', 'SECTION', 'COMPONENT_SET']);

/** A cheap check (no subtree walk) that "Create component" applies: layers that are not all
 *  components, outside instances, components and sets. The operation itself refuses the rest. */
export function canOfferComponent(doc: DesignDocument, ids: readonly NodeId[]): boolean {
  const top = topLevelSelection(doc, ids);
  // All components already, or all instances (their own section has their actions; ⌥⌘K still wraps them).
  if (!top.length || top.every(id => doc.nodes[id]?.type === 'COMPONENT') || top.every(id => doc.nodes[id]?.type === 'INSTANCE')) return false;
  return top.every(id => {
    const node = doc.nodes[id];
    if (!node || node.mainId !== undefined || (REFUSED.has(node.type))) return false;
    for (let parent = node.parentId ? doc.nodes[node.parentId] : undefined; parent; parent = parent.parentId ? doc.nodes[parent.parentId] : undefined) {
      if (parent.type === 'COMPONENT' || parent.type === 'COMPONENT_SET' || parent.type === 'INSTANCE') return false;
    }
    return true;
  });
}

type HeaderState = {create: 0 | 1 | 2; combine: boolean};

export function ComponentHeaderActions({ids}: SectionProps) {
  const services = useComponentHost();
  const store = services.store;
  const state = useDocValue(services, (doc): HeaderState => ({
    create: canOfferComponent(doc, ids) ? (topLevelSelection(doc, ids).length > 1 ? 2 : 1) : 0,
    combine: combinable(doc, ids).length > 1,
  }));
  const menu = useMenuTrigger({
    label: 'Create component',
    minWidth: 220,
    items: useCallback((): MenuItem[] => [
      {id: 'one', label: 'Create component', shortcut: 'Alt+Mod+KeyK', onSelect: () => void createComponentsFromSelection(store)},
      {id: 'many', label: 'Create multiple components', onSelect: () => void createComponentsFromSelection(store, true)},
    ], [store]),
  });
  if (!state.create && !state.combine) return null;
  return (
    <>
      {state.create === 1 && <IconButton label="Create component" shortcut="Alt+Mod+KeyK" className="dz-cmp-header-btn" onClick={() => createComponentsFromSelection(store)}><IconComponent /></IconButton>}
      {state.create === 2 && (
        <>
          <IconButton label="Create component" shortcut="Alt+Mod+KeyK" className="dz-cmp-header-btn" {...menu.triggerProps}><IconComponent /></IconButton>
          {menu.element}
        </>
      )}
      {state.combine && <IconButton label="Combine as variants" className="dz-cmp-header-btn" onClick={() => combineSelectionAsVariants(store)}><IconVariant /></IconButton>}
    </>
  );
}

/** The descriptor the selection header's registry takes (shape of its HeaderAction). */
export const componentHeaderAction: {id: string; order: number; applies(selection: SelectionInfo): boolean; Component: ComponentType<SectionProps>} = {
  id: 'components',
  order: 10,
  applies: selection => selection.nodes.some(node => node.type !== 'PAGE'),
  Component: ComponentHeaderActions,
};
