import {memo, useCallback, useContext, useRef, useState} from 'react';
import type {BooleanOperation} from '../../../../shared/design/types';
import {EditorServicesContext} from '../../editor/services';
import {applyBoolean, BOOLEAN_LABELS, BOOLEAN_MESSAGES, BOOLEAN_OPERATIONS, BOOLEAN_SHORTCUTS, planBoolean} from '../../engine/commands/boolean';
import {flattenSelection} from '../../engine/commands/vector';
import {SHAPE_BUILDER_LABEL, startShapeBuilder} from '../../engine/commands/shape-builder';
import type {DesignStore, EditorState} from '../../engine/store';
import {shallowEqual, useDesignStore} from '../../engine/useDesignStore';
import {IconButton} from '../../ui/Button';
import {IconExclude, IconFlatten, IconIntersect, IconSubtract, IconUnion, type IconComponent} from '../../ui/icons';
import {IconShapeBuilder} from './layout/icons';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import '../../styles/vector.css';

// "Boolean operations" as a split button for the selection header of the design panel: the button
// applies the operation it shows (the selected boolean's own, otherwise the last one used), the
// chevron opens the four operations, "Flatten" and "Shape builder" (Figma's Shape builder). Disabled while the selection cannot take part
// (one plain layer, nothing); a selection with text stays enabled so the command can say why it
// leaves the text out.

export const BOOLEAN_ICONS: Record<BooleanOperation, IconComponent> = {UNION: IconUnion, SUBTRACT: IconSubtract, INTERSECT: IconIntersect, EXCLUDE: IconExclude};

/** The operation the button shows when no boolean is selected (Figma remembers the last one). */
let lastUsed: BooleanOperation = 'UNION';

type View = {enabled: boolean; current: BooleanOperation | null};

const viewOf = (state: EditorState): View => {
  const plan = planBoolean(state.doc, state.selection);
  return {
    enabled: plan.kind !== 'none' || plan.reason === BOOLEAN_MESSAGES.text,
    current: plan.kind === 'change' ? plan.operation ?? 'UNION' : null,
  };
};

export type BooleanMenuProps = {
  /** Defaults to the open file's store (useEditorServices). */
  store?: DesignStore;
};

export const BooleanMenu = memo(function BooleanMenu({store: given}: BooleanMenuProps) {
  const services = useContext(EditorServicesContext);
  const store = given ?? services?.store;
  if (!store) throw new Error('BooleanMenu needs a store (prop or editor services)');
  const view = useDesignStore(viewOf, shallowEqual, {slice: ['doc', 'selection'], store});
  const [, rerender] = useState(0);
  const shown = view.current ?? lastUsed;
  const run = useCallback((operation: BooleanOperation) => {
    lastUsed = operation;
    applyBoolean(store, operation);
    rerender(value => value + 1);
  }, [store]);
  const items = useCallback((): MenuItem[] => {
    const current = viewOf(store.getState()).current;
    return [
      ...BOOLEAN_OPERATIONS.map(operation => {
        const Icon = BOOLEAN_ICONS[operation];
        return {id: operation, label: BOOLEAN_LABELS[operation], shortcut: BOOLEAN_SHORTCUTS[operation], icon: <Icon />, checked: current === operation, radio: true, onSelect: () => run(operation)} satisfies MenuItem;
      }),
      {type: 'separator'},
      {id: 'flatten', label: 'Flatten', shortcut: 'Mod+KeyE', icon: <IconFlatten />, onSelect: () => void flattenSelection(store)},
      {id: 'shape-builder', label: SHAPE_BUILDER_LABEL, icon: <IconShapeBuilder />, onSelect: () => void startShapeBuilder(store)},
    ];
  }, [store, run]);
  const box = useRef<HTMLDivElement>(null);
  const menu = useMenuTrigger({items, label: 'Boolean operations', placement: 'bottom-start', minWidth: 200, anchor: () => box.current});
  const chevronTip = useTooltip(menu.open ? null : {label: 'Boolean operations'});
  const Icon = BOOLEAN_ICONS[shown];
  return (
    <div ref={box} className={`dz-boolean-menu ${view.enabled ? '' : 'is-disabled'}`.trim()} role="group" aria-label="Boolean operations">
      <IconButton label={BOOLEAN_LABELS[shown]} shortcut={BOOLEAN_SHORTCUTS[shown]} disabled={!view.enabled} onClick={() => run(shown)}>
        <Icon />
      </IconButton>
      <button type="button" className="dz-boolean-chevron" aria-label="Boolean operations" disabled={!view.enabled} {...chevronTip} {...menu.triggerProps}>
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {menu.element}
    </div>
  );
});
