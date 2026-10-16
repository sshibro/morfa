import {memo, useCallback} from 'react';
import type {DesignDocument, LayoutMode, NodeId, SceneNode} from '../../../../shared/design/types';
import {TYPE_NAMES} from '../../../../shared/design/defaults';
import {shallowEqual} from '../../engine/useDesignStore';
import type {EditorState} from '../../engine/store';
import {getCommand, type Shortcut} from '../../engine/commands/registry';
import {IconButton} from '../../ui/Button';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import {IconChevronDown, IconAlignBottom, IconAlignCenterH, IconAlignCenterV, IconAlignLeft, IconAlignRight, IconAlignTop, IconDistributeH, IconDistributeV, IconMask, layerIcon} from '../../ui/icons';
import {maskPlanKind, toggleMask} from '../../engine/commands/mask';
import {BooleanMenu} from './BooleanMenu';
import {componentHeaderAction} from './components/ComponentHeaderActions';
import type {SelectionInfo} from './sections';
import {ALIGN_LABELS, alignAvailability, alignSelection, alignToParents, distributeSelection, tidyUpSelection, type AlignMode} from '../../engine/commands/align';
import {IconMultiEdit, IconTidy} from './layout/icons';
import {variantMultiEdit} from '../../engine/variant-multi-edit';
import {sizeUpdates} from './layout/geometry';
import {FRAME_PRESET_GROUPS} from '../frame-presets';
import {applyUpdates, usePanelState, usePanelStore} from './shared/edit';
import {registerHeaderAction, useHeaderActions, type HeaderAction} from './shared/header-actions';
import {layersLabel} from './shared/mixed';
import '../../styles/panel-layout.css';

// The row above the "Design" sections: what is selected (its type icon and name, or "3 layers") and the quick actions
// other features register (shared/header-actions.ts). Self-contained: it reads the selection from the store, so the
// panel host renders <SelectionHeader /> above the sections. `AlignmentRow` — six aligns, then distribute (3+ layers)
// and "Tidy up" (2+) in a menu, all through the arrange commands' own helpers (src/design/engine/commands/align.ts),
// so the menu, the shortcuts and the panel move layers the same way — is the first row of "Position", as in UI3.

// The header's actions, as in Figma's: the component feature's "Create component" / "Combine as
// variants" (components/ComponentHeaderActions.tsx), the vector feature's boolean split button
// (BooleanMenu.tsx) for two or more layers or a boolean, and "Use as mask" for two or more
// layers or a mask.
registerHeaderAction(componentHeaderAction);
registerHeaderAction({
  id: 'boolean', order: 20,
  applies: ({nodes}) => nodes.length >= 2 || nodes.some(node => node.type === 'BOOLEAN_OPERATION'),
  Component: function BooleanAction() {
    return <BooleanMenu />;
  },
});
registerHeaderAction({
  // Figma's Multi-edit variants (Q): the same layer in every variant of the set.
  id: 'multi-edit-variants', order: 15,
  applies: ({doc, ids}) => !!variantMultiEdit(doc, ids),
  Component: function MultiEditVariantsAction({ids}) {
    const store = usePanelStore();
    return (
      <IconButton label="Edit all variants" shortcut="KeyQ" onClick={() => {
        const next = variantMultiEdit(store.getState().doc, ids);
        if (next) store.setSelection(next);
      }}><IconMultiEdit /></IconButton>
    );
  },
});
registerHeaderAction({
  id: 'mask', order: 30,
  applies: ({nodes}) => nodes.length >= 2 || nodes.some(node => node.isMask),
  Component: MaskAction,
});

// Selectors of the state alone are written once here: the render after a change then reuses the answer the store's
// listener just worked out instead of asking again (a new function every render would), which over a 5 000-layer
// selection is milliseconds each.
const maskPlanOf = (state: EditorState) => maskPlanKind(state.doc, state.selection);
const alignOf = (state: EditorState) => alignAvailability(state.doc, state.selection);

function MaskAction() {
  const store = usePanelStore();
  const plan = usePanelState(maskPlanOf);
  const unmask = plan === 'unmask';
  return (
    <IconButton label={unmask ? 'Remove mask' : 'Use as mask'} shortcut={shortcutOf('object.mask')} pressed={unmask} disabled={plan === 'none'}
      onClick={() => {
        const selected = toggleMask(store);
        if (selected.length) store.setSelection(selected);
      }}>
      <IconMask />
    </IconButton>
  );
}

const ALIGN: readonly {mode: AlignMode; Icon: typeof IconAlignLeft}[] = [
  {mode: 'left', Icon: IconAlignLeft},
  {mode: 'center-h', Icon: IconAlignCenterH},
  {mode: 'right', Icon: IconAlignRight},
  {mode: 'top', Icon: IconAlignTop},
  {mode: 'center-v', Icon: IconAlignCenterV},
  {mode: 'bottom', Icon: IconAlignBottom},
];

/** A registered command's keys as tooltips print them, or nothing while no command has them (a
 *  tooltip never promises a shortcut that does not work). */
function shortcutOf(id: string): string | undefined {
  const shortcut: Shortcut | undefined = getCommand(id)?.shortcut;
  if (!shortcut) return undefined;
  return [shortcut.ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.mod && 'Mod', shortcut.code].filter(Boolean).join('+');
}


/** What the header shows, small and comparable: dragging a selected layer changes none of it, so the
 *  header does not re-render on the frames of a drag. */
type Summary = {ids: readonly NodeId[]; title: string; type: SceneNode['type'] | null; mask: boolean; image: boolean; layout: LayoutMode | undefined; actions: readonly string[]};
const NO_SUMMARY: Summary = {ids: [], title: '', type: null, mask: false, image: false, layout: undefined, actions: []};

function summaryOf(doc: DesignDocument, selection: readonly NodeId[], actions: readonly HeaderAction[]): Summary {
  const nodes = selection.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node);
  if (!nodes.length) return NO_SUMMARY;
  const ids = nodes.map(node => node.id);
  const single = nodes.length === 1 ? nodes[0] : null;
  const info: SelectionInfo = {doc, ids, nodes};
  return {
    ids,
    // UI3 names the kind of layer ("Frame", "Rectangle"); components, sets and instances by their own names.
    title: single ? (NAMED_TYPES.has(single.type) ? single.name || TYPE_NAMES[single.type] : TYPE_NAMES[single.type]) : layersLabel(nodes.length),
    type: single?.type ?? null,
    mask: !!single?.isMask,
    image: !!single?.fills.some(fill => fill.type === 'IMAGE'),
    layout: single?.autoLayout?.layoutMode,
    actions: actions.filter(action => action.applies(info)).map(action => action.id),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
const sameSummary = (a: Summary, b: Summary) =>
  a.title === b.title && a.type === b.type && a.mask === b.mask && a.image === b.image && a.layout === b.layout && sameList(a.ids, b.ids) && sameList(a.actions, b.actions);

export const SelectionHeader = memo(function SelectionHeader() {
  const store = usePanelStore();
  const actions = useHeaderActions();
  const summary = usePanelState(useCallback((state: EditorState) => summaryOf(state.doc, state.selection, actions), [actions]), sameSummary);

  if (!summary.ids.length) return null;
  const Icon = summary.type ? layerIcon(summary.type, {mask: summary.mask, image: summary.image, layout: summary.layout}) : null;
  const component = summary.type === 'COMPONENT' || summary.type === 'INSTANCE' || summary.type === 'COMPONENT_SET';
  const shown = actions.filter(action => summary.actions.includes(action.id));
  const doc = store.getState().doc;
  const nodes = summary.ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node);

  return (
    <div className="dz-pl-header">
      <div className="dz-pl-header-row">
        <span className={`dz-pl-header-icon ${component ? 'is-component' : ''}`.trim()} aria-hidden="true">
          {Icon ? <Icon /> : <MultiIcon />}
        </span>
        {summary.type === 'FRAME' ? <FramePresetMenu id={summary.ids[0]} title={summary.title} /> : <span className="dz-pl-header-title" title={summary.title}>{summary.title}</span>}
        {shown.length > 0 && (
          <div className="dz-pl-header-actions">
            {shown.map(action => <action.Component key={action.id} ids={summary.ids} nodes={nodes} />)}
          </div>
        )}
      </div>
    </div>
  );
});

/** The six aligns in two wells, then distribute (3+ layers) and "Tidy up" (2+) in a menu: the first row of "Position",
 *  as in UI3. Memoized without props: a drag re-renders none of it. */
export const AlignmentRow = memo(function AlignmentRow() {
  const store = usePanelStore();
  const can = usePanelState(alignOf, shallowEqual);
  // ⇧: each layer to its own parent frame, as Figma's (layers in different frames line up inside each).
  const align = useCallback((mode: AlignMode, toParents: boolean) => (toParents ? alignToParents(store, mode) : alignSelection(store, mode)), [store]);
  return (
    <div className="dz-pl-align" role="toolbar" aria-label="Alignment">
      <div className="dz-pl-align-group">
        {ALIGN.slice(0, 3).map(item => <AlignButton key={item.mode} item={item} disabled={!can.align} onAlign={align} />)}
      </div>
      <div className="dz-pl-align-group">
        {ALIGN.slice(3).map(item => <AlignButton key={item.mode} item={item} disabled={!can.align} onAlign={align} />)}
      </div>
      <ArrangeMenu distribute={can.distribute} tidy={can.tidy} />
    </div>
  );
});

/** Components, sets and instances are headed by their names; other layers by their kind. */
const NAMED_TYPES = new Set<SceneNode['type']>(['COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** "Frame ▾": the frame's presets, as UI3's Frame dropdown (help.figma.com "Frames in Figma Design"): a size from the
 *  groups of `frame-presets.ts` resizes the selected frame, its place kept, its children by their constraints. */
function FramePresetMenu({id, title}: {id: NodeId; title: string}) {
  const store = usePanelStore();
  const items = useCallback((): MenuItem[] => FRAME_PRESET_GROUPS.map(group => ({
    type: 'submenu', id: group.id, label: group.label,
    items: group.presets.map((preset): MenuItem => ({
      id: preset.id, label: preset.name, description: `${preset.width} × ${preset.height}`,
      onSelect: () => store.transact('Frame size', tx => {
        if (tx.get(id)) applyUpdates(tx, sizeUpdates(tx.doc, id, {width: preset.width, height: preset.height}, false), each => each === id);
      }),
    })),
  })), [id, store]);
  const menu = useMenuTrigger({items, label: 'Frame size', minWidth: 220});
  const tip = useTooltip(menu.open ? null : {label: 'Frame size'});
  return (
    <>
      <button type="button" className="dz-pl-header-title is-menu" aria-label={`${title}: frame size`} {...tip} {...menu.triggerProps}>
        <span>{title}</span>
        <IconChevronDown size={12} />
      </button>
      {menu.element}
    </>
  );
}

function MultiIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="2.75" y="5.25" width="8" height="8" rx="1.25" />
      <path d="M5.25 2.75h6.75a1.25 1.25 0 0 1 1.25 1.25v6.75" />
    </svg>
  );
}

function AlignButton({item, disabled, onAlign}: {item: (typeof ALIGN)[number]; disabled: boolean; onAlign: (mode: AlignMode, toParents: boolean) => void}) {
  return (
    <IconButton label={ALIGN_LABELS[item.mode]} shortcut={shortcutOf(`arrange.align-${item.mode}`)} disabled={disabled} className="dz-pl-align-btn" onClick={event => onAlign(item.mode, event.shiftKey)}>
      <item.Icon />
    </IconButton>
  );
}

function ArrangeMenu({distribute, tidy}: {distribute: boolean; tidy: boolean}) {
  const store = usePanelStore();
  const items = useCallback((): MenuItem[] => [
    {id: 'distribute-h', label: 'Distribute horizontal spacing', icon: <IconDistributeH />, shortcut: shortcutOf('arrange.distribute-h'), disabled: !distribute,
      onSelect: () => distributeSelection(store, 'horizontal')},
    {id: 'distribute-v', label: 'Distribute vertical spacing', icon: <IconDistributeV />, shortcut: shortcutOf('arrange.distribute-v'), disabled: !distribute,
      onSelect: () => distributeSelection(store, 'vertical')},
    {type: 'separator'},
    {id: 'tidy', label: 'Tidy up', icon: <IconTidy />, shortcut: shortcutOf('arrange.tidy-up'), disabled: !tidy, onSelect: () => tidyUpSelection(store)},
  ], [distribute, tidy, store]);
  const menu = useMenuTrigger({items, label: 'Distribute', minWidth: 220, placement: 'bottom-end'});
  const tip = useTooltip({label: 'Distribute and tidy up'});
  return (
    <>
      <button type="button" aria-label="Distribute and tidy up" disabled={!tidy} {...tip} {...menu.triggerProps} className="dz-icon-btn is-24 is-panel">
        <IconDistributeH />
      </button>
      {menu.element}
    </>
  );
}
