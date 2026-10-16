import {useCallback, useEffect, useRef, useState} from 'react';
import type {NodeId} from '../../../../../shared/design/types';
import type {EditorServices} from '../../../editor/services';
import {Button, IconButton} from '../../../ui/Button';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {Popover} from '../../../ui/Popover';
import {TextInput} from '../../../ui/TextInput';
import {Toggle} from '../../../ui/Toggle';
import {IconChevronDown, IconClose, IconInstance, IconPlus} from '../../../ui/icons';
import {bindLayers, PROPERTY_TYPE_LABELS, removeProperty, renameProperty, renameValue, setPropertyDefault} from './actions';
import {useDocValue} from './hooks';
import {bindableLayers, boundLayerGroups, boundLayers, componentLabel, propertyRows, type PropertyRow} from './model';
import {propertyDefinitionsOf} from '../../../../../shared/design/components';
import {SwapMenu} from './SwapMenu';
import {PropertyTypeIcon} from './PropertyTypeIcon';

// The popover of one component property (a row of "Properties"): its name, its default value (or, for a
// variant property, its values), the layers it drives with "Bind layer", and "Delete property".

export type PropertyEditorProps = {
  services: EditorServices;
  anchor: Element;
  /** The set or component holding the definition. */
  ownerId: NodeId;
  /** The component whose layers the picker offers (the selected variant, or the owner). */
  componentId: NodeId;
  propertyKey: string;
  onKeyChange: (key: string) => void;
  onClose: () => void;
  /** A property just added: its name field takes the focus with the name selected. */
  focusName?: boolean;
};

/** "1 variant", "3 variants". */
export function variantsLabel(count: number): string {
  return `${count} ${count === 1 ? 'variant' : 'variants'}`;
}

export function PropertyEditor({services, anchor, ownerId, componentId, propertyKey, onKeyChange, onClose, focusName = false}: PropertyEditorProps) {
  const store = services.store;
  const row = useDocValue(services, doc => {
    const rows = propertyRows(propertyDefinitionsOf(doc, ownerId));
    return [...rows.variant, ...rows.other].find(each => each.key === propertyKey) ?? null;
  });
  const bound = useDocValue(services, doc => (row && row.type !== 'VARIANT' ? boundLayerGroups(doc, ownerId, propertyKey) : []));
  const [name, setName] = useState(row?.name ?? '');
  // The popover focuses its first control once it is placed; a new property's name takes over a frame later.
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusName) return;
    const frame = requestAnimationFrame(() => {
      nameField.current?.focus({preventScroll: true});
      nameField.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusName]);
  const lastName = useRef(row?.name);
  if (row && row.name !== lastName.current) {
    lastName.current = row.name;
    setName(row.name);
  }

  const picker = useMenuTrigger({
    label: 'Bind layer',
    minWidth: 200,
    items: useCallback((): MenuItem[] => {
      if (!row || row.type === 'VARIANT') return [];
      const doc = store.getState().doc;
      const groups = bindableLayers(doc, componentId, row.type);
      const bound = new Set(boundLayers(doc, ownerId, propertyKey).map(layer => layer.id));
      if (!groups.length) return [{id: 'none', label: row.type === 'TEXT' ? 'The component has no text layers' : row.type === 'INSTANCE_SWAP' ? 'The component has no nested instances' : 'The component has no layers', disabled: true, onSelect: () => {}}];
      const field = row.type === 'BOOLEAN' ? 'visible' : row.type === 'TEXT' ? 'characters' : 'mainComponent';
      return groups.map(group => {
        const all = group.ids.every(id => bound.has(id));
        const where = group.total > 1 ? (group.variants === group.total ? 'in all variants' : `in ${group.variants} of ${group.total} variants`) : '';
        return {id: group.key, label: group.name, description: [group.path, where].filter(Boolean).join(' · ') || undefined, checked: all,
          onSelect: () => bindLayers(store, group.ids, field, all ? null : propertyKey)};
      });
    }, [row, store, componentId, ownerId, propertyKey]),
  });

  if (!row) return null;
  const commitName = (value: string) => {
    if (!value.trim() || value.trim() === row.name) {
      setName(row.name);
      return;
    }
    const next = renameProperty(store, ownerId, row.key, value, row.type === 'VARIANT');
    if (next) onKeyChange(next);
    else setName(row.name);
  };

  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" aria-label={`Property "${row.name}"`} className="dz-prop-popover" layoutKey={bound.length}>
      <div className="dz-prop-editor">
        <div className="dz-prop-editor-head">
          <span className="dz-prop-editor-type"><PropertyTypeIcon type={row.type} />{PROPERTY_TYPE_LABELS[row.type]}</span>
          <IconButton label="Close" tooltip={false} onClick={onClose}><IconClose /></IconButton>
        </div>
        <label className="dz-prop-editor-field">
          <span className="dz-prop-editor-label">Name</span>
          <TextInput value={name} onChange={setName} onCommit={commitName} onCancel={() => setName(row.name)} aria-label="Property name" selectOnFocus inputRef={nameField} />
        </label>
        <DefaultValue services={services} ownerId={ownerId} row={row} />
        {row.type !== 'VARIANT' && (
          <div className="dz-prop-editor-field">
            <span className="dz-prop-editor-label">Layers</span>
            {bound.length ? (
              <ul className="dz-prop-bound">
                {bound.map(group => (
                  <li key={`${group.name}:${group.field}`} className="dz-prop-bound-item">
                    <span className="dz-prop-bound-name" title={group.name}>{group.name}</span>
                    {group.ids.length > 1 && <span className="dz-prop-bound-field">{variantsLabel(group.ids.length)}</span>}
                    <IconButton label={`Unbind "${group.name}"`} onClick={() => bindLayers(store, group.ids, group.field, null)}><IconClose size={14} /></IconButton>
                  </li>
                ))}
              </ul>
            ) : <p className="dz-prop-editor-hint">The property does not affect anything yet.</p>}
            <Button variant="ghost" static icon={<IconPlus />} className="dz-prop-bind" {...picker.triggerProps}>Bind layer</Button>
            {picker.element}
          </div>
        )}
        <div className="dz-prop-editor-foot">
          <Button variant="ghost" static className="dz-prop-delete" onClick={() => {
            removeProperty(store, ownerId, row.key);
            onClose();
          }}>Delete property</Button>
        </div>
      </div>
    </Popover>
  );
}

function DefaultValue({services, ownerId, row}: {services: EditorServices; ownerId: NodeId; row: PropertyRow}) {
  const store = services.store;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const componentName = useDocValue(services, doc => (row.type === 'INSTANCE_SWAP' ? componentLabel(doc, String(row.defaultValue)) : null));
  if (row.type === 'VARIANT') {
    return (
      <div className="dz-prop-editor-field">
        <span className="dz-prop-editor-label">Values</span>
        <div className="dz-prop-values">
          {(row.options ?? []).map(option => <ValueField key={option} value={option} isDefault={option === row.defaultValue} onRename={next => renameValue(store, ownerId, row.key, option, next)} />)}
        </div>
      </div>
    );
  }
  let control;
  if (row.type === 'BOOLEAN') {
    control = <Toggle checked={row.defaultValue === true} onChange={value => setPropertyDefault(store, ownerId, row.key, value)} aria-label="Default value">{row.defaultValue === true ? 'True' : 'False'}</Toggle>;
  } else if (row.type === 'TEXT') {
    control = <DraftField value={String(row.defaultValue)} label="Default value" onCommit={value => setPropertyDefault(store, ownerId, row.key, value)} />;
  } else {
    control = (
      <>
        <button ref={anchor} type="button" className={`dz-cmp-swap is-field ${open ? 'is-open' : ''}`.trim()} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(next => !next)}>
          <span className="dz-cmp-swap-icon"><IconInstance size={14} /></span>
          <span className="dz-cmp-swap-name">{componentName}</span>
          <span className="dz-cmp-swap-chevron"><IconChevronDown size={12} /></span>
        </button>
        {open && anchor.current && (
          <SwapMenu services={services} anchor={anchor.current} current={String(row.defaultValue)} preferred={row.preferredValues} label="Default component"
            onPick={id => setPropertyDefault(store, ownerId, row.key, id)} onClose={() => setOpen(false)} />
        )}
      </>
    );
  }
  return (
    <div className="dz-prop-editor-field">
      <span className="dz-prop-editor-label">Default</span>
      {control}
    </div>
  );
}

/** A text field that writes on Enter or blur and follows outside changes while untouched. */
function DraftField({value, label, onCommit}: {value: string; label: string; onCommit: (value: string) => void}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  if (value !== last.current) {
    last.current = value;
    setDraft(value);
  }
  return <TextInput value={draft} onChange={setDraft} aria-label={label} onCommit={next => (next !== value ? onCommit(next) : undefined)} onCancel={() => setDraft(value)} />;
}

function ValueField({value, isDefault, onRename}: {value: string; isDefault: boolean; onRename: (value: string) => void}) {
  const [draft, setDraft] = useState(value);
  return (
    <TextInput value={draft} onChange={setDraft} aria-label={`Value "${value}"`} end={isDefault ? <span className="dz-prop-default-mark" title="Default variant value">default</span> : undefined}
      onCommit={next => {
        if (!next.trim() || next.trim() === value) setDraft(value);
        else onRename(next.trim());
      }}
      onCancel={() => setDraft(value)} />
  );
}
