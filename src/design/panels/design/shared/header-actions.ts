import {useSyncExternalStore, type ComponentType} from 'react';
import type {SectionProps, SelectionInfo} from '../sections';

// Quick actions in the "Design" panel's selection header (SelectionHeader.tsx), filled by the
// features that own them: component actions ("Create component", "Go to main"), the
// boolean operations menu, "Use as mask"... A feature registers its action once at
// module load; the header shows those whose `applies` holds for the selection, by `order`, as
// 24 px icon buttons (the component renders its own IconButton or menu trigger).
//
//   registerHeaderAction({id: 'boolean', order: 20, applies: s => s.nodes.length > 1, Component: BooleanMenu});

export type HeaderAction = {
  id: string;
  /** Left to right. Components 10, booleans 20, mask 30 by convention. */
  order: number;
  applies(selection: SelectionInfo): boolean;
  Component: ComponentType<SectionProps>;
};

let actions: readonly HeaderAction[] = [];
const listeners = new Set<() => void>();

/** Adds (or replaces, by id) an action. Returns its removal. */
export function registerHeaderAction(action: HeaderAction): () => void {
  actions = [...actions.filter(each => each.id !== action.id), action].sort((a, b) => a.order - b.order);
  listeners.forEach(listener => listener());
  return () => {
    if (!actions.includes(action)) return;
    actions = actions.filter(each => each !== action);
    listeners.forEach(listener => listener());
  };
}

export const headerActions = (): readonly HeaderAction[] => actions;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Every registered action, in order (re-renders when one is added late). */
export function useHeaderActions(): readonly HeaderAction[] {
  return useSyncExternalStore(subscribe, headerActions, headerActions);
}
