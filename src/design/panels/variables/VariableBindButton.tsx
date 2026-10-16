import {useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode} from 'react';
import type {DesignDocument, NodeId, RGBA, Variable, VariableType} from '../../../../shared/design/types';
import {resolveVariable} from '../../../../shared/design/variables';
import {useEditorServices, type EditorServices} from '../../editor/services';
import {shallowEqual, useDesignStore} from '../../engine/useDesignStore';
import {Button, IconButton} from '../../ui/Button';
import {cssColor} from '../../ui/ColorSwatch';
import {Popover} from '../../ui/Popover';
import {TextInput} from '../../ui/TextInput';
import {IconCheck, IconClose, IconHash, IconSearch, IconText, IconToggle, IconVariable} from '../../ui/icons';
import {MIXED, sameModel} from '../design/components/model';
import {offsetToPanelEdge} from '../design/shared/fields';
import {bindingState, bindVariableTo, VARIABLE_TYPE_LABELS, type VariableBindingState, type VariableBindTarget} from './binding';
import '../../styles/panel-components.css';

export {bindingState, bindVariableTo, type VariableBindingState, type VariableBindTarget} from './binding';

// "Apply variable": the hexagon beside a number field (width, height, gap, padding, radius,
// opacity...) or a solid paint. It lists the file's variables of the type the field takes
// (BINDABLE_FIELDS: numbers for sizes, booleans for visibility, strings for text), binds the chosen one
// to every selected layer (bindVariable / bindPaintVariable, one undo step; inside an instance the
// binding is an override), and while bound the field shows the variable as a chip with "Detach".
//
//   const width = useVariableBinding('width');
//   {width.chip ?? <NumberField … />}{width.button}

const EMPTY: readonly NodeId[] = [];

function useTargetIds(services: EditorServices, ids?: readonly NodeId[]): readonly NodeId[] {
  const selection = useDesignStore(state => (ids ? EMPTY : state.selection), shallowEqual, {slice: 'selection', store: services.store});
  return ids ?? selection;
}

export type VariableBindButtonProps = {
  /** A field of BINDABLE_FIELDS, e.g. 'width', 'itemSpacing', 'cornerRadius', 'opacity'. */
  field?: string;
  /** Or the colour of a solid paint (the paint panel's swatch). */
  paint?: {target: 'fills' | 'strokes'; index: number};
  /** The layers to bind; the selection by default. */
  ids?: readonly NodeId[];
  className?: string;
  /** Set to a function that opens the list, for a field to open it as Figma does on "=". */
  opener?: MutableRefObject<(() => void) | null>;
};

const toTarget = (field?: string, paint?: VariableBindButtonProps['paint']): VariableBindTarget =>
  paint ? {paint: paint.target, index: paint.index} : {field: field ?? ''};

/** The hexagon button: opens the variable list for the target. */
export function VariableBindButton({field, paint, ids, className = '', opener}: VariableBindButtonProps) {
  const services = useEditorServices();
  const targetIds = useTargetIds(services, ids);
  const target = useMemo(() => toTarget(field, paint), [field, paint?.target, paint?.index]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useDesignStore(store => bindingState(store.doc, targetIds, target), sameModel, {slice: 'doc', store: services.store});
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const available = !!state;
  useEffect(() => {
    if (!opener) return;
    opener.current = available ? () => setOpen(true) : null;
    return () => {
      opener.current = null;
    };
  }, [opener, available]);
  if (!state) return null;
  const bound = state.variableId !== null;
  return (
    <>
      <IconButton ref={anchor} label={bound ? 'Change variable' : 'Apply variable'} pressed={open || undefined} aria-expanded={open} aria-haspopup="dialog"
        className={`dz-varbind ${bound ? 'is-bound' : ''} ${className}`.trim()} onClick={() => setOpen(next => !next)}>
        <IconVariable size={14} />
      </IconButton>
      {open && anchor.current && <VariablePicker services={services} anchor={anchor.current} ids={targetIds} target={target} state={state} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The binding of a field for panels: the state, the hexagon button and, while bound, the chip that
 *  stands in place of the field. */
export function useVariableBinding(field: string, options: {ids?: readonly NodeId[]; paint?: VariableBindButtonProps['paint']; opener?: VariableBindButtonProps['opener']} = {}): {
  state: VariableBindingState | null; button: ReactNode; chip: ReactNode | null;
} {
  const services = useEditorServices();
  const targetIds = useTargetIds(services, options.ids);
  const target = useMemo(() => toTarget(field, options.paint), [field, options.paint?.target, options.paint?.index]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useDesignStore(store => bindingState(store.doc, targetIds, target), sameModel, {slice: 'doc', store: services.store});
  const button = <VariableBindButton field={field} paint={options.paint} ids={options.ids} opener={options.opener} />;
  const chip = state && state.variableId !== null ? <VariableChip services={services} ids={targetIds} target={target} state={state} /> : null;
  return {state, button, chip};
}

/** A bound field: the variable's name in place of the value; click to change, × to unbind. */
export function VariableChip({services, ids, target, state}: {services: EditorServices; ids: readonly NodeId[]; target: VariableBindTarget; state: VariableBindingState}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = state.variableId === MIXED ? 'Mixed variables' : state.name ?? 'Deleted variable';
  return (
    <div className="dz-var-chip">
      <button ref={anchor} type="button" className="dz-var-chip-main" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(next => !next)} title={label}>
        <span className="dz-var-chip-icon"><IconVariable size={12} /></span>
        <span className="dz-var-chip-name">{label}</span>
      </button>
      <IconButton label="Detach variable" className="dz-var-chip-detach" onClick={() => bindVariableTo(services.store, ids, target, null)}><IconClose size={12} /></IconButton>
      {open && anchor.current && <VariablePicker services={services} anchor={anchor.current} ids={ids} target={target} state={state} onClose={() => setOpen(false)} />}
    </div>
  );
}

type PickerItem = {variable: Variable; collection: string; label: string; value: string | RGBA | null};

function displayValue(doc: DesignDocument, variable: Variable, nodeId: NodeId | undefined): string | RGBA | null {
  const value = resolveVariable(doc, variable.id, undefined, nodeId);
  if (value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  return value;
}

function TypeGlyph({type, value}: {type: VariableType; value: string | RGBA | null}) {
  if (type === 'COLOR') {
    const color = value && typeof value === 'object' ? value : null;
    return <span className="dz-swatch dz-var-swatch" style={{'--dz-swatch': color ? cssColor(color) : 'transparent'} as CSSProperties} />;
  }
  if (type === 'BOOLEAN') return <IconToggle size={14} />;
  if (type === 'STRING') return <IconText size={14} />;
  return <IconHash size={14} />;
}

function VariablePicker({services, anchor, ids, target, state, onClose}: {
  services: EditorServices; anchor: Element; ids: readonly NodeId[]; target: VariableBindTarget; state: VariableBindingState; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const items = useMemo((): PickerItem[] => {
    const doc = services.store.getState().doc;
    const out: PickerItem[] = [];
    for (const collection of Object.values(doc.variableCollections)) {
      for (const variableId of collection.variableIds) {
        const variable = doc.variables[variableId];
        if (!variable || variable.type !== state.type) continue;
        out.push({variable, collection: collection.name, label: variable.name, value: displayValue(doc, variable, ids[0])});
      }
    }
    return out;
  }, [services, state.type, ids]);
  const fold = (text: string) => text.toLocaleLowerCase('en').replace(/\u0451/g, '\u0435');
  const shown = items.filter(item => fold(`${item.collection} ${item.label}`).includes(fold(query.trim())));
  const groups: {collection: string; items: PickerItem[]}[] = [];
  for (const item of shown) {
    const last = groups[groups.length - 1];
    if (last?.collection === item.collection) last.items.push(item);
    else groups.push({collection: item.collection, items: [item]});
  }
  const pick = (id: string) => {
    bindVariableTo(services.store, ids, target, id);
    onClose();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.key === 'Enter') {
      const id = active ?? (shown.length === 1 ? shown[0].variable.id : null);
      if (id) pick(id);
      return;
    }
    if (!shown.length) return;
    const at = active ? shown.findIndex(item => item.variable.id === active) : -1;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    setActive(shown[(at + step + shown.length) % shown.length].variable.id);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" offset={offsetToPanelEdge(anchor)} aria-label="Variables" className="dz-var-popover">
      <div className="dz-var-picker" onKeyDown={keyDown} data-dz-menu="">
        <div className="dz-swap-search">
          <TextInput value={query} onChange={value => {setQuery(value); setActive(null);}} icon={<IconSearch />} placeholder="Search variables" aria-label="Search variables" autoFocus />
        </div>
        <div className="dz-var-list" role="listbox" aria-label={`Variables: ${VARIABLE_TYPE_LABELS[state.type].toLowerCase()}`}>
          {groups.map(group => (
            <div key={group.collection} className="dz-swap-group">
              <div className="dz-swap-heading">{group.collection}</div>
              {group.items.map(item => {
                const current = item.variable.id === state.variableId;
                return (
                  <button key={item.variable.id} type="button" role="option" aria-selected={current}
                    className={`dz-var-item ${active === item.variable.id ? 'is-active' : ''} ${current ? 'is-current' : ''}`.trim()}
                    onPointerMove={() => {if (active !== item.variable.id) setActive(item.variable.id);}} onClick={() => pick(item.variable.id)}>
                    <span className="dz-var-item-icon"><TypeGlyph type={state.type} value={item.value} /></span>
                    <span className="dz-var-item-name" title={item.label}>{item.label}</span>
                    {item.value !== null && typeof item.value !== 'object' && <span className="dz-var-item-value">{item.value}</span>}
                    {current && <span className="dz-swap-check"><IconCheck /></span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!shown.length && <p className="dz-swap-empty">{items.length ? 'Nothing found' : `The file has no variables of type "${VARIABLE_TYPE_LABELS[state.type]}"`}</p>}
        </div>
        {state.variableId !== null && (
          <div className="dz-var-foot">
            <Button variant="ghost" static onClick={() => {bindVariableTo(services.store, ids, target, null); onClose();}}>Detach variable</Button>
          </div>
        )}
      </div>
    </Popover>
  );
}
