import {memo, useCallback, useMemo, useRef, useState} from 'react';
import type {NodeId} from '../../../../../shared/design/types';
import {defaultVariant, isExposableInstance, wouldCreateCycle} from '../../../../../shared/design/components';
import type {DesignDocument} from '../../../../../shared/design/types';
import type {EditorServices} from '../../../editor/services';
import {
  detachSelectedInstances, goToMain, hasOverrides, pushSelectedToMain, resetSelectedInstances, restoreMainOf, selectAllInstances,
} from '../../../engine/commands/components';
import {Button, IconButton} from '../../../ui/Button';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {PanelSection} from '../../../ui/PanelSection';
import {Select} from '../../../ui/Select';
import {TextInput} from '../../../ui/TextInput';
import {Toggle} from '../../../ui/Toggle';
import {IconChevronDown, IconComponent, IconDetach, IconInstance, IconMore, IconRestore, IconWarning} from '../../../ui/icons';
import {editNodes} from '../../../engine/user-edit';
import type {SectionProps} from '../sections';
import {sameSectionProps} from '../shared/edit';
import {setInstancesProperty, swapInstances} from './actions';
import {useComponentHost, useDocValue} from './hooks';
import {componentLabel, exposedGroups, instanceModel, MIXED, type ExposedGroup, type InstanceRow, type SwapEntry} from './model';
import {SwapMenu} from './SwapMenu';
import '../../../styles/panel-components.css';

// "Instance": what the selected instance shows and how to change it, as in Figma. The main
// component's name opens the swap menu; variant properties are dropdowns, booleans switches, texts
// fields and instance swaps their own swap menus. Header: "Reset all changes", "Detach
// instance" and "⋯" (go to the main, push changes to it). Several instances show what they share.

export const InstanceSection = memo(function InstanceSection({ids}: SectionProps) {
  const services = useComponentHost();
  const store = services.store;
  const model = useDocValue(services, doc => instanceModel(doc, ids));
  const overridden = useDocValue(services, doc => ids.some(id => doc.nodes[id]?.type === 'INSTANCE' && hasOverrides(doc, id)));
  const swapAnchor = useRef<HTMLButtonElement>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const idsKey = model?.ids.join('\u0000') ?? '';
  // A nested instance may not show a component it sits in.
  const exclude = useMemo(() => {
    const parents = idsKey ? idsKey.split('\u0000') : [];
    return (entry: SwapEntry) => {
      const doc = store.getState().doc;
      return parents.some(id => {
        const parent = doc.nodes[id]?.parentId;
        return !!parent && wouldCreateCycle(doc, resolveEntry(doc, entry), parent);
      });
    };
  }, [store, idsKey]);

  const instanceIds = model?.ids ?? [];
  const single = instanceIds.length === 1 ? instanceIds[0] : null;
  // Exposed nested instances show their properties below this instance's own (one instance at a time).
  const exposed = useDocValue(services, doc => (single ? exposedGroups(doc, single) : NO_GROUPS));
  // A nested instance inside a main can be exposed to the main's instances.
  const exposable = useDocValue(services, doc => (single && isExposableInstance(doc, single) ? {exposed: !!doc.nodes[single].isExposedInstance} : null));
  const topLevel = !model?.nested;
  const more = useMenuTrigger({
    label: 'More instance actions',
    minWidth: 220,
    items: useCallback((): MenuItem[] => [
      {id: 'go', label: 'Go to main component', disabled: !single || !model || model.orphan, onSelect: () => single && goToMain(store, single)},
      {id: 'select-instances', label: 'Select all instances', disabled: !single || typeof model?.componentId !== 'string',
        onSelect: () => typeof model?.componentId === 'string' && void selectAllInstances(store, model.componentId)},
      {id: 'push', label: 'Push changes to main component', disabled: !topLevel || !overridden || !!model?.orphan, onSelect: () => pushSelectedToMain(store)},
      ...(model?.orphan && single ? [{id: 'restore', label: 'Restore main component', onSelect: () => void restoreMainOf(store, single)} satisfies MenuItem] : []),
      ...(exposable && single ? [{id: 'expose', label: 'Show properties in instances', checked: exposable.exposed,
        onSelect: () => editNodes(store, exposable.exposed ? 'Hide nested instance properties' : 'Show nested instance properties', [single], () => ({isExposedInstance: exposable.exposed ? undefined : true}))} satisfies MenuItem] : []),
      {type: 'separator'},
      {id: 'reset', label: 'Reset all changes', disabled: !overridden, onSelect: () => resetSelectedInstances(store)},
      {id: 'detach', label: 'Detach instance', shortcut: 'Alt+Mod+KeyB', disabled: !topLevel, onSelect: () => detachSelectedInstances(store)},
    ], [single, model, topLevel, overridden, store, exposable]),
  });

  if (!model) return null;
  const mainName = model.mainName === MIXED ? 'Mixed' : model.mainName;
  const current = model.swapId === MIXED ? null : model.swapId;

  return (
    <PanelSection title="Instance" className="dz-cmp-section" actions={
      <>
        <IconButton label="Reset all changes" disabled={!overridden} onClick={() => resetSelectedInstances(store)}><IconRestore /></IconButton>
        <IconButton label="Detach instance" shortcut="Alt+Mod+KeyB" disabled={!topLevel} onClick={() => detachSelectedInstances(store)}><IconDetach /></IconButton>
        <IconButton label="More instance actions" {...more.triggerProps}><IconMore /></IconButton>
        {more.element}
      </>
    }>
      <div className="dz-cmp-main">
        <button ref={swapAnchor} type="button" className={`dz-cmp-swap ${swapOpen ? 'is-open' : ''}`.trim()} aria-haspopup="dialog" aria-expanded={swapOpen}
          title={model.orphan ? 'Main component deleted' : 'Swap instance'} onClick={() => setSwapOpen(open => !open)}>
          <span className="dz-cmp-swap-icon"><IconInstance /></span>
          <span className={`dz-cmp-swap-name ${model.mainName === MIXED ? 'is-mixed' : ''}`.trim()}>{mainName}</span>
          <span className="dz-cmp-swap-chevron"><IconChevronDown size={12} /></span>
        </button>
        <IconButton label="Go to main component" disabled={!single || model.orphan} onClick={() => single && goToMain(store, single)}><IconComponent /></IconButton>
      </div>
      {model.orphan && (
        <div className="dz-cmp-note is-warning" role="status">
          <IconWarning />
          <span>Main component deleted</span>
          {single && <Button variant="ghost" static onClick={() => restoreMainOf(store, single)}>Restore</Button>}
        </div>
      )}
      {model.rows.length > 0 && (
        <div className="dz-cmp-rows">
          {model.rows.map(row => <PropertyControl key={row.key} services={services} ids={instanceIds} row={row} />)}
        </div>
      )}
      {exposable?.exposed && <p className="dz-cmp-hint">This instance's properties are shown in instances of the main component.</p>}
      {exposed.map(group => <ExposedProperties key={group.id} services={services} group={group} />)}
      {swapOpen && swapAnchor.current && (
        <SwapMenu services={services} anchor={swapAnchor.current} current={current} exclude={exclude}
          onPick={id => swapInstances(store, instanceIds, id)} onClose={() => setSwapOpen(false)} />
      )}
    </PanelSection>
  );
}, sameSectionProps);

const NO_GROUPS: ExposedGroup[] = [];

/** An exposed nested instance's properties, under its name, set on the copy inside this instance. */
function ExposedProperties({services, group}: {services: EditorServices; group: ExposedGroup}) {
  const ids = useMemo(() => [group.id], [group.id]);
  return (
    <div className="dz-cmp-exposed" role="group" aria-label={`"${group.name}" properties`}>
      <button type="button" className="dz-cmp-exposed-name" title="Select nested instance" onClick={() => services.store.setSelection(ids)}>
        <IconInstance size={14} /><span>{group.name}</span>
      </button>
      <div className="dz-cmp-rows">
        {group.rows.map(row => <PropertyControl key={row.key} services={services} ids={ids} row={row} />)}
      </div>
    </div>
  );
}

/** The component a swap entry stands for: a set gives its default variant, as swapping does. */
const resolveEntry = (doc: DesignDocument, entry: SwapEntry) => (entry.kind === 'set' ? defaultVariant(doc, entry.id) ?? entry.id : entry.id);

/** One property of the selected instances. */
function PropertyControl({services, ids, row}: {services: EditorServices; ids: readonly NodeId[]; row: InstanceRow}) {
  const store = services.store;
  const set = (value: string | boolean, coalesce?: string) => setInstancesProperty(store, ids, row.key, value, coalesce);
  const mixed = row.value === MIXED;
  let control;
  if (row.type === 'VARIANT') {
    const options = (row.options ?? []).map(option => ({value: option, label: option}));
    control = <Select value={mixed ? null : String(row.value)} mixed={mixed} options={options} onChange={value => set(value)} aria-label={row.name} />;
  } else if (row.type === 'BOOLEAN') {
    control = (
      <span className="dz-cmp-toggle-wrap" title={mixed ? 'Mixed' : undefined}>
        <Toggle checked={mixed ? 'mixed' : row.value === true} onChange={checked => set(mixed ? true : checked)} aria-label={mixed ? `${row.name}: mixed` : row.name} className={`dz-cmp-toggle ${mixed ? 'is-mixed' : ''}`.trim()} />
      </span>
    );
  } else if (row.type === 'TEXT') {
    control = <TextInput value={mixed ? '' : String(row.value)} placeholder={mixed ? 'Mixed' : ''} aria-label={row.name}
      onChange={value => set(value, `instance-text:${ids.join(',')}:${row.key}`)} />;
  } else {
    control = <SwapField services={services} ids={ids} row={row} />;
  }
  return (
    <div className="dz-cmp-row">
      <span className="dz-cmp-label" title={row.name}>{row.name}</span>
      <div className="dz-cmp-control">{control}</div>
    </div>
  );
}

/** An INSTANCE_SWAP property: the component it shows, with the swap menu (preferred ones first). */
function SwapField({services, ids, row}: {services: EditorServices; ids: readonly NodeId[]; row: InstanceRow}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const value = row.value === MIXED ? null : String(row.value);
  const name = useDocValue(services, doc => (value ? componentLabel(doc, value) : null));
  // Not the instance's own component (or set), nor one that would contain it.
  const exclude = useMemo(() => (entry: SwapEntry) => {
    const doc = services.store.getState().doc;
    return ids.some(id => {
      const main = doc.nodes[doc.nodes[id]?.componentId ?? ''];
      if (main && (main.id === entry.id || main.parentId === entry.id)) return true;
      return wouldCreateCycle(doc, resolveEntry(doc, entry), id);
    });
  }, [services, ids]);
  return (
    <>
      <button ref={anchor} type="button" className={`dz-cmp-swap is-field ${open ? 'is-open' : ''}`.trim()} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${row.name}: ${name ?? 'Mixed'}`} onClick={() => setOpen(next => !next)}>
        <span className="dz-cmp-swap-icon"><IconInstance size={14} /></span>
        <span className={`dz-cmp-swap-name ${name ? '' : 'is-mixed'}`.trim()}>{name ?? 'Mixed'}</span>
        <span className="dz-cmp-swap-chevron"><IconChevronDown size={12} /></span>
      </button>
      {open && anchor.current && (
        <SwapMenu services={services} anchor={anchor.current} current={value} preferred={row.preferredValues} exclude={exclude} label={row.name}
          onPick={id => setInstancesProperty(services.store, ids, row.key, id)} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
