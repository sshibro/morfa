import {memo, useCallback, useRef, useState} from 'react';
import type {ComponentPropertyType, DesignDocument, NodeId} from '../../../../../shared/design/types';
import type {VariantIssue} from '../../../../../shared/design/variants';
import type {EditorServices} from '../../../editor/services';
import {addVariantToSet, combinable, combineSelectionAsVariants, insertInstance, instancesByPage, selectAllInstances} from '../../../engine/commands/components';
import {Button, IconButton} from '../../../ui/Button';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {PanelSection} from '../../../ui/PanelSection';
import {TextInput} from '../../../ui/TextInput';
import {TextArea} from '../../../ui/TextArea';
import {IconChevronDown, IconInstance, IconMore, IconPlus, IconVariant, IconWarning} from '../../../ui/icons';
import {editNodes} from '../../../engine/user-edit';
import type {SectionProps} from '../sections';
import {sameSectionProps} from '../shared/edit';
import {addProperty, PROPERTY_TYPE_LABELS, setDescription, setVariantValue} from './actions';
import {useComponentHost, useDocValue} from './hooks';
import {componentLabel, componentModel, nestedInstancesOf, type ComponentModel, type PropertyRow} from './model';
import {PropertyEditor} from './PropertyEditor';
import {PropertyTypeIcon} from './PropertyTypeIcon';
import '../../../styles/panel-components.css';

// "Component" / "Variant" / "Component set": the description, the properties (variants, booleans,
// texts, instance swaps) with "+" to add one and a popover to edit it, a variant's own values, "Add
// variant" for sets and a warning when two variants share a combination. Several main components
// selected: "Combine as variants".

const TITLES = {component: 'Component', variant: 'Variant', set: 'Component set'} as const;
const ADDABLE: readonly ComponentPropertyType[] = ['VARIANT', 'BOOLEAN', 'TEXT', 'INSTANCE_SWAP'];

export const ComponentSection = memo(function ComponentSection({ids}: SectionProps) {
  const services = useComponentHost();
  const model = useDocValue(services, doc => componentModel(doc, ids));
  const many = useDocValue(services, doc => (ids.length > 1 ? combinable(doc, ids).length : 0));
  if (model) return <SingleComponent services={services} model={model} />;
  if (many > 1) {
    return (
      <PanelSection title="Components" className="dz-cmp-section">
        <Button icon={<IconVariant />} static className="dz-cmp-wide" onClick={() => combineSelectionAsVariants(services.store)}>Combine as variants</Button>
      </PanelSection>
    );
  }
  return null;
}, sameSectionProps);

function SingleComponent({services, model}: {services: EditorServices; model: ComponentModel}) {
  const store = services.store;
  const [editing, setEditing] = useState<string | null>(null);
  // A property just added opens with its name selected, ready to be typed over (as in Figma).
  const [fresh, setFresh] = useState<string | null>(null);
  const add = useMenuTrigger({
    label: 'Add property',
    minWidth: 200,
    items: useCallback((): MenuItem[] => {
      // Nested instances whose properties the component's instances show too (Figma's "Nested instances").
      const nested = model.kind === 'set' ? [] : nestedInstancesOf(store.getState().doc, model.id);
      return [
        {type: 'label', label: 'New property'},
        ...ADDABLE.map((type): MenuItem => ({id: type, label: PROPERTY_TYPE_LABELS[type], icon: <PropertyTypeIcon type={type} />, onSelect: () => {
          const added = addProperty(store, model.id, type);
          if (added) {
            setEditing(added.key);
            setFresh(added.key);
          }
        }})),
        ...(nested.length ? [
          {type: 'separator'} satisfies MenuItem,
          {type: 'label', label: 'Nested instance properties'} satisfies MenuItem,
          ...nested.map((node): MenuItem => ({id: 'nested:' + node.id, label: node.name, checked: !!node.isExposedInstance, icon: <IconInstance />,
            onSelect: () => editNodes(store, node.isExposedInstance ? 'Hide nested instance properties' : 'Show nested instance properties', [node.id],
              () => ({isExposedInstance: node.isExposedInstance ? undefined : true}))})),
        ] : []),
      ];
    }, [store, model.id, model.kind]),
  });
  const more = useMenuTrigger({
    label: 'More component actions',
    minWidth: 200,
    items: useCallback((): MenuItem[] => [
      {id: 'instance', label: 'Create instance', onSelect: () => void insertInstance(store, model.id)},
      // A variant's own instances; the set's are all its variants'.
      {id: 'select-instances', label: 'Select all instances', disabled: !instancesByPage(store.getState().doc, model.id).size, onSelect: () => void selectAllInstances(store, model.id)},
      ...(model.setId ? [{id: 'variant', label: 'Add variant', onSelect: () => void addVariantToSet(store, model.setId!, model.kind === 'variant' ? model.id : undefined)} satisfies MenuItem] : []),
      ...(model.kind === 'variant' ? [{id: 'set', label: 'Select component set', onSelect: () => store.setSelection([model.setId!])} satisfies MenuItem] : []),
    ], [store, model.id, model.setId, model.kind]),
  });
  // A variant edits its own values above; the set's variant properties are edited on the set.
  const rows = model.kind === 'variant' ? model.properties : [...model.variantProperties, ...model.properties];

  return (
    <PanelSection title={TITLES[model.kind]} className="dz-cmp-section" actions={
      <>
        <IconButton label="More component actions" {...more.triggerProps}><IconMore /></IconButton>
        {more.element}
      </>
    }>
      <Description key={model.id} value={model.description} onCommit={value => setDescription(store, model.id, value)} />
      {model.kind === 'variant' && model.values && model.variantProperties.length > 0 && (
        <div className="dz-cmp-rows">
          {model.variantProperties.map(row => (
            <div className="dz-cmp-row" key={row.key}>
              <span className="dz-cmp-label" title={row.name}>{row.name}</span>
              <div className="dz-cmp-control">
                <VariantValueField value={model.values![row.key] ?? ''} options={row.options ?? []} label={row.name} onCommit={value => setVariantValue(store, model.id, row.key, value)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="dz-cmp-subhead">
        <span>Properties</span>
        <IconButton label="Add property" {...add.triggerProps}><IconPlus /></IconButton>
        {add.element}
      </div>
      {rows.length ? (
        <ul className="dz-cmp-props">
          {rows.map(row => (
            <PropertyItem key={row.key} services={services} model={model} row={row} open={editing === row.key} fresh={fresh === row.key}
              onOpen={() => {
                setFresh(null);
                setEditing(row.key);
              }}
              onClose={() => {
                setFresh(null);
                setEditing(current => (current === row.key ? null : current));
              }} onKeyChange={key => {
                setFresh(null);
                setEditing(key);
              }} />
          ))}
        </ul>
      ) : (
        <p className="dz-cmp-empty">No properties yet: variants, layer toggles, texts and nested instance swaps.</p>
      )}
      {model.kind === 'set' && (
        <Button icon={<IconPlus />} static className="dz-cmp-wide" onClick={() => addVariantToSet(store, model.id)}>Add variant</Button>
      )}
      <Issues services={services} issues={model.issues} />
    </PanelSection>
  );
}

function PropertyItem({services, model, row, open, fresh, onOpen, onClose, onKeyChange}: {
  services: EditorServices; model: ComponentModel; row: PropertyRow; open: boolean; fresh: boolean; onOpen: () => void; onClose: () => void; onKeyChange: (key: string) => void;
}) {
  // A state, not a ref: a property just added opens its editor on the render that adds its row, before a ref would be set.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const summary = useDocValue(services, doc => summaryOf(doc, row));
  return (
    <li>
      <button ref={setAnchor} type="button" className={`dz-cmp-prop ${open ? 'is-open' : ''}`.trim()} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen())}>
        <span className="dz-cmp-prop-icon"><PropertyTypeIcon type={row.type} /></span>
        <span className="dz-cmp-prop-name" title={row.name}>{row.name}</span>
        <span className="dz-cmp-prop-value" title={summary}>{summary}</span>
      </button>
      {open && anchor && (
        <PropertyEditor services={services} anchor={anchor} ownerId={model.ownerId} componentId={model.id} propertyKey={row.key}
          onKeyChange={onKeyChange} onClose={onClose} focusName={fresh} />
      )}
    </li>
  );
}

/** What a property row shows on the right: the default value ("True", a text, a component), or a
 *  variant property's values. */
function summaryOf(doc: DesignDocument, row: PropertyRow): string {
  if (row.type === 'VARIANT') return (row.options ?? []).join(', ');
  if (row.type === 'BOOLEAN') return row.defaultValue === true ? 'True' : 'False';
  if (row.type === 'TEXT') return String(row.defaultValue) || '—';
  return componentLabel(doc, String(row.defaultValue));
}

function Description({value, onCommit}: {value: string; onCommit: (value: string) => void}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  if (value !== last.current) {
    last.current = value;
    setDraft(value);
  }
  return (
    <TextArea value={draft} onChange={setDraft} appearance="quiet" className="dz-cmp-description" placeholder="Add a description"
      aria-label="Component description" onCommit={next => (next !== value ? onCommit(next) : undefined)} onCancel={() => setDraft(value)} />
  );
}

/** A variant's value: type a new one, or pick one the set already has. */
function VariantValueField({value, options, label, onCommit}: {value: string; options: readonly string[]; label: string; onCommit: (value: string) => void}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  if (value !== last.current) {
    last.current = value;
    setDraft(value);
  }
  const menu = useMenuTrigger({
    label,
    minWidth: 140,
    items: useCallback((): MenuItem[] => options.map(option => ({id: option, label: option, checked: option === value, radio: true, onSelect: () => onCommit(option)})), [options, value, onCommit]),
  });
  return (
    <>
      <TextInput value={draft} onChange={setDraft} aria-label={label} onCancel={() => setDraft(value)}
        onCommit={next => {
          const clean = next.trim();
          if (!clean || clean.includes(',') || clean.includes('=')) setDraft(value);
          else if (clean !== value) onCommit(clean);
        }}
        end={<IconButton label={`"${label}" values`} tooltip={false} className="dz-cmp-combo" {...menu.triggerProps}><IconChevronDown size={12} /></IconButton>} />
      {menu.element}
    </>
  );
}

function Issues({services, issues}: {services: EditorServices; issues: readonly VariantIssue[]}) {
  if (!issues.length) return null;
  const duplicates = issues.filter((issue): issue is Extract<VariantIssue, {type: 'duplicate'}> => issue.type === 'duplicate');
  const names = issues.some(issue => issue.type === 'invalid_name');
  const missing = issues.some(issue => issue.type === 'missing_value');
  const strays = issues.some(issue => issue.type === 'not_component');
  const select = (ids: NodeId[]) => services.store.setSelection(ids);
  return (
    <div className="dz-cmp-issues" role="status">
      {duplicates.map(issue => (
        <div className="dz-cmp-note is-warning" key={issue.name}>
          <IconWarning />
          <span>Duplicate variants: {issue.name}</span>
          <Button variant="ghost" static onClick={() => select(issue.ids)}>Select</Button>
        </div>
      ))}
      {names && <div className="dz-cmp-note is-warning"><IconWarning /><span>Variant names must look like "Property=Value"</span></div>}
      {missing && <div className="dz-cmp-note is-warning"><IconWarning /><span>Some variants have no property value</span></div>}
      {strays && <div className="dz-cmp-note is-warning"><IconWarning /><span>The set contains layers that are not variants</span></div>}
    </div>
  );
}
