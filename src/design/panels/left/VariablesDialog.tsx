import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react';
import type {DesignDocument, RGBA, Variable, VariableCollection, VariableType, VariableValue} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {nextNumberedName} from '../../../../shared/design/tree';
import {addVariableMode, createVariable, createVariableCollection, deleteVariable, deleteVariableCollection, isAlias, removeVariableMode, renameVariable, renameVariableCollection, renameVariableMode, resolveVariable, setDefaultVariableMode, setVariableValue, wouldCreateAliasCycle, type VariableEdit} from '../../../../shared/design/variables';
import {useDesignStore} from '../../engine/useDesignStore';
import {useEditorServices} from '../../editor/services';
import {Button, IconButton} from '../../ui/Button';
import {ColorSwatch} from '../../ui/ColorSwatch';
import {Dialog} from '../../ui/Dialog';
import {IconChevronDown, IconChevronRight, IconClose, IconLink, IconMore, IconPlus, IconSearch, IconText, IconVarBoolean, IconVarColor, IconVarNumber, IconVariables, type IconComponent} from '../../ui/icons';
import {Popover} from '../../ui/Popover';
import {IconProtoExitFullscreen, IconProtoFullscreen} from '../../prototype/icons';
import {TextArea} from '../../ui/TextArea';
import {useContextMenu, useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {NumberField} from '../../ui/NumberField';
import {EmptyState} from '../../ui/ProgressBar';
import {TextInput} from '../../ui/TextInput';
import {Toggle} from '../../ui/Toggle';
import {commitEdit} from './apply-edit';
import {colorHex, leafName, parseHex} from './assets-model';
import {chain, clickSelect, duplicateMode, duplicateVariables, moveToGroup, renameGroup, reorderMode, reorderVariables, tableRows} from './variables-table';
import '../../styles/panel-left.css';

// "Variables": collections on the left; the chosen collection as a table with a column per mode and a
// row per variable, grouped by "/" in their names. Values are edited in place (a colour by hex, a
// number, a string, a switch) or point at another variable of the same type (an alias, never one that
// leads back). Every edit goes through shared/design/variables.ts and lands as one undo step; bound
// layers follow in the same step.

export const TYPE_ICONS: Record<VariableType, IconComponent> = {COLOR: IconVarColor, FLOAT: IconVarNumber, STRING: IconText, BOOLEAN: IconVarBoolean};
const TYPE_LABELS: Record<VariableType, string> = {COLOR: 'Color', FLOAT: 'Number', STRING: 'String', BOOLEAN: 'Boolean'};
const DEFAULT_NAMES: Record<VariableType, string> = {COLOR: 'Color', FLOAT: 'Number', STRING: 'String', BOOLEAN: 'Boolean'};

type Run = (label: string, op: (doc: DesignDocument) => VariableEdit, coalesce?: string) => VariableEdit | null;

let fullSize = false;

export function VariablesDialog({onClose}: {onClose: () => void}) {
  const {store, toast} = useEditorServices();
  const doc = useDesignStore(state => state.doc, (a, b) => a.variableCollections === b.variableCollections && a.variables === b.variables, {store, slice: 'doc'});
  const collections = Object.values(doc.variableCollections);
  const [currentId, setCurrentId] = useState<string | null>(() => collections[0]?.id ?? null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Figma's full-size toggle: the dialog takes the window (remembered while the editor is open).
  const [full, setFull] = useState(fullSize);
  const menu = useContextMenu();
  const current = currentId ? doc.variableCollections[currentId] : undefined;
  useEffect(() => {
    if (!current && collections.length) setCurrentId(collections[0].id);
  }, [current, collections]);

  const run: Run = (label, op, coalesce) => {
    const before = store.getState().doc;
    // A shared library's collection (docs/design-tool.md §Teams) is read-only here: it changes in the library's file.
    if (current?.remote) {
      toast('Library variables are changed in the library file.');
      return null;
    }
    try {
      const edit = op(before);
      commitEdit(store, label, before, edit, coalesce ? {coalesce} : undefined);
      return edit;
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Something went wrong', 'error');
      return null;
    }
  };

  const addCollection = () => {
    const id = newId();
    const name = nextNumberedName('Collection', collections.map(each => each.name));
    if (run('New collection', d => createVariableCollection(d, {id, name, modes: [{modeId: newId(), name: 'Mode 1'}]}))) {
      setCurrentId(id);
      setRenaming(id);
    }
  };

  const collectionMenu = (event: ReactMouseEvent, collection: VariableCollection) => {
    menu.open(event, [
      {id: 'collection.rename', label: 'Rename', onSelect: () => setRenaming(collection.id)},
      {type: 'separator'},
      {id: 'collection.delete', label: 'Delete collection', danger: true, onSelect: () => run('Delete collection', d => deleteVariableCollection(d, collection.id))},
    ]);
  };

  return (
    <Dialog title="Variables" onClose={onClose} width={full ? 4096 : 960} className={`dz-variables-dialog ${full ? 'is-full' : ''}`.trim()}
      actions={<IconButton label={full ? 'Restore size' : 'Full screen'} pressed={full} onClick={() => setFull((fullSize = !full))}>
        {full ? <IconProtoExitFullscreen /> : <IconProtoFullscreen />}
      </IconButton>}>
      <div className="dz-variables">
        <aside className="dz-variables-side" aria-label="Collections">
          <div className="dz-variables-side-head">
            <span>Collections</span>
            <IconButton label="Create collection" onClick={addCollection}><IconPlus /></IconButton>
          </div>
          <div className="dz-variables-collections" role="listbox" aria-label="Collections">
            {collections.map(collection => (
              <div key={collection.id} role="option" aria-selected={collection.id === currentId} tabIndex={collection.id === currentId ? 0 : -1}
                className={`dz-variables-collection ${collection.id === currentId ? 'is-current' : ''}`.trim()}
                onClick={() => setCurrentId(collection.id)} onDoubleClick={() => !collection.remote && setRenaming(collection.id)}
                onContextMenu={event => (collection.remote ? event.preventDefault() : collectionMenu(event, collection))}
                onKeyDown={event => {
                  if (event.key === 'F2') setRenaming(collection.id);
                }}>
                {renaming === collection.id
                  ? <NameField initial={collection.name} label="Collection name" onDone={value => {
                    setRenaming(null);
                    if (value && value.trim() !== collection.name) run('Rename collection', d => renameVariableCollection(d, collection.id, value));
                  }} />
                  : <>
                    <span className="dz-variables-collection-name">{collection.name}</span>
                    <span className="dz-variables-count">{collection.variableIds.length}</span>
                  </>}
              </div>
            ))}
          </div>
        </aside>
        <section className="dz-variables-main" aria-label={current ? `Collection "${current.name}"` : 'Collection'}>
          {current?.remote && <p className="dz-variables-remote-note">Library collection: values are changed in the library file and arrive here with an update.</p>}
          {current ? (
            <fieldset disabled={!!current.remote} className="dz-readonly-fieldset"><VariableTable key={current.id} doc={doc} collection={current} run={run} /></fieldset>
          ) : (
            <div className="dz-variables-empty">
              <EmptyState icon={<IconVariables />} title="No variables yet" actions={<Button size={32} variant="primary" icon={<IconPlus />} onClick={addCollection}>Create collection</Button>}>
                Variables store colors, numbers, strings and booleans, and modes hold their values for light and dark themes, languages or screen sizes.
              </EmptyState>
            </div>
          )}
        </section>
      </div>
      {menu.element}
    </Dialog>
  );
}

// ── The table ──────────────────────────────────────────────────────────────────────────────────
//
// As Figma's ("Guide to variables in Figma", "Modes for variables"): the head row stays while the rows scroll, the
// "Name" column stays while the modes scroll sideways under their own bar, "Add mode" is pinned at the head's
// right edge, "Create variable" at the foot outside the scroll. Only the mode columns move sideways: their track
// shifts by --dz-vars-x (the bar under them sets it), so the name column and the pinned column never scroll.

const NAME_WIDTH = 240;
const MODE_MIN = 120;
const MODE_DEFAULT = 180;
const WIDTH_MAX = 640;
/** The type a dragged row carries, so other drags (files, text) are not taken for one. */
const ROW_DRAG = 'application/x-morfa-variables';
const MODE_DRAG = 'application/x-morfa-variable-mode';

type Widths = Record<string, number>;

function VariableTable({doc, collection, run}: {doc: DesignDocument; collection: VariableCollection; run: Run}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingMode, setRenamingMode] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [editing, setEditing] = useState<{id: string; anchor: Element} | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [widths, setWidths] = useState<Widths>({});
  const [viewport, setViewport] = useState(0);
  const [drop, setDrop] = useState<{kind: 'row' | 'group' | 'mode'; key: string; after?: boolean} | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const modesHead = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const modes = collection.modes;
  const rows = tableRows(doc, collection, folded, query);
  const order = rows.flatMap(row => (row.kind === 'variable' ? [row.variable.id] : []));
  const live = selected.filter(id => doc.variables[id]?.collectionId === collection.id);

  // Column widths: the name column, and each mode's (dragged ones fixed, the others share what is left, never under
  // MODE_MIN); the track is as wide as their sum, so the bar knows how far the modes go.
  const nameWidth = widths.name ?? Math.min(NAME_WIDTH, Math.max(110, Math.round(viewport * 0.32)));
  const fixed = modes.reduce((sum, mode) => sum + (widths[mode.modeId] ?? 0), 0);
  const free = modes.filter(mode => widths[mode.modeId] === undefined).length;
  const modesViewport = Math.max(0, viewport - nameWidth - 40);
  const share = free ? Math.max(MODE_MIN, Math.floor((modesViewport - fixed) / free)) : 0;
  const modeWidths = modes.map(mode => widths[mode.modeId] ?? Math.max(share, Math.min(MODE_DEFAULT, share)));
  const trackWidth = modeWidths.reduce((sum, width) => sum + width, 0);
  const style = {
    '--dz-vars-name': `${nameWidth}px`,
    '--dz-vars-cols': modeWidths.map(width => `${width}px`).join(' '),
    '--dz-vars-track': `${trackWidth}px`,
  } as CSSProperties;

  // The table's width, and the scrollbar the rows take, which the bar under the modes leaves out too.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      setViewport(element.clientWidth);
      root.current?.style.setProperty('--dz-vars-gutter', `${element.offsetWidth - element.clientWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The bar under the modes moves their track; the edges show a divider while modes are scrolled under them.
  const shift = () => {
    const x = bar.current?.scrollLeft ?? 0;
    const max = Math.max(0, trackWidth - modesViewport);
    const element = root.current;
    if (!element) return;
    element.style.setProperty('--dz-vars-x', `${-Math.min(x, max)}px`);
    element.classList.toggle('is-scrolled-start', x > 0);
    element.classList.toggle('is-scrolled-end', x < max - 1);
  };
  useLayoutEffect(shift);
  // A sideways wheel or trackpad swipe over the rows moves the modes; ⇧ with the wheel too, as elsewhere.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const dx = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!dx || !bar.current) return;
      bar.current.scrollLeft += dx;
      if (Math.abs(dx) >= Math.abs(event.deltaY) || event.shiftKey) event.preventDefault();
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  // A field focused in a mode out of view (Tab, Enter) brings that mode in.
  const reveal = (cell: HTMLElement) => {
    const index = Number(cell.dataset.modeIndex);
    if (!Number.isFinite(index) || !bar.current) return;
    const left = modeWidths.slice(0, index).reduce((sum, width) => sum + width, 0);
    const right = left + modeWidths[index];
    const x = bar.current.scrollLeft;
    if (left < x - 1) bar.current.scrollLeft = left;
    else if (right > x + modesViewport + 1) bar.current.scrollLeft = right - modesViewport;
  };

  const create = (type: VariableType) => {
    const id = newId();
    const names = collection.variableIds.map(each => doc.variables[each]?.name ?? '');
    // Into the group of the selected row, as Figma's "Create variable" does.
    const group = live.length ? doc.variables[live[live.length - 1]]?.name.split('/').slice(0, -1).join('/') : '';
    const base = nextNumberedName(DEFAULT_NAMES[type], names.map(leafName));
    if (run('New variable', d => createVariable(d, {id, name: group ? `${group}/${base}` : base, collectionId: collection.id, type}))) {
      setRenaming(id);
      setSelected([id]);
      setAnchor(id);
    }
  };
  const createMenu = useMenuTrigger({
    label: 'Variable type',
    placement: 'top-start',
    items: () => (['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] as VariableType[]).map(type => {
      const Icon = TYPE_ICONS[type];
      return {id: `variable.new.${type}`, label: TYPE_LABELS[type], icon: <Icon />, onSelect: () => create(type)};
    }),
  });
  const addMode = () => {
    const modeId = newId();
    const name = nextNumberedName('Mode', modes.map(mode => mode.name));
    if (run('New mode', d => addVariableMode(d, collection.id, {modeId, name}))) {
      setRenamingMode(modeId);
      // The new mode is the last: bring it in.
      requestAnimationFrame(() => {
        if (bar.current) bar.current.scrollLeft = bar.current.scrollWidth;
      });
    }
  };
  const modeItems = (modeId: string): MenuItem[] => {
    const index = modes.findIndex(mode => mode.modeId === modeId);
    return [
      {id: 'mode.rename', label: 'Rename', onSelect: () => setRenamingMode(modeId)},
      {id: 'mode.duplicate', label: 'Duplicate mode', onSelect: () => run('Duplicate mode', d => duplicateMode(d, collection.id, modeId))},
      {id: 'mode.default', label: 'Set as default', disabled: collection.defaultModeId === modeId, onSelect: () => run('Default mode', d => setDefaultVariableMode(d, collection.id, modeId))},
      {type: 'separator'},
      {id: 'mode.left', label: 'Move left', disabled: index <= 0, onSelect: () => run('Reorder modes', d => reorderMode(d, collection.id, modeId, modes[index - 1].modeId))},
      {id: 'mode.right', label: 'Move right', disabled: index >= modes.length - 1, onSelect: () => run('Reorder modes', d => reorderMode(d, collection.id, modeId, modes[index + 2]?.modeId ?? null))},
      {type: 'separator'},
      {id: 'mode.delete', label: 'Delete mode', danger: true, disabled: modes.length < 2, onSelect: () => run('Delete mode', d => removeVariableMode(d, collection.id, modeId))},
    ];
  };
  const targets = (variable: Variable) => (live.includes(variable.id) ? live : [variable.id]);
  const removeVariables = (ids: readonly string[]) => {
    if (run(ids.length > 1 ? 'Delete variables' : 'Delete variable', d => chain(d, ...ids.map(id => (each: DesignDocument) => deleteVariable(each, id))))) setSelected([]);
  };
  const duplicate = (ids: readonly string[]) => {
    let made: string[] = [];
    if (run(ids.length > 1 ? 'Duplicate variables' : 'Duplicate variable', d => {
      const edit = duplicateVariables(d, ids);
      made = edit.ids;
      return edit;
    })) setSelected(made);
  };
  const newGroup = (ids: readonly string[]) => {
    const taken = collection.variableIds.map(id => doc.variables[id]?.name.split('/').slice(0, -1).join('/') ?? '');
    const parent = doc.variables[ids[0]]?.name.split('/').slice(0, -1).join('/') ?? '';
    const name = nextNumberedName('Group', taken.map(path => path.split('/').pop() ?? ''));
    const path = parent ? `${parent}/${name}` : name;
    if (run('New group', d => moveToGroup(d, ids, path))) setRenamingGroup(path);
  };
  const rowMenu = (event: ReactMouseEvent, variable: Variable) => {
    const ids = targets(variable);
    if (!live.includes(variable.id)) {
      setSelected([variable.id]);
      setAnchor(variable.id);
    }
    const many = ids.length > 1;
    const row = (event.currentTarget as Element).querySelector('.dz-variables-cell.is-name') ?? (event.currentTarget as Element);
    menu.open(event, [
      ...(many ? [] : [
        {id: 'variable.edit', label: 'Edit variable', onSelect: () => setEditing({id: variable.id, anchor: row})},
        {id: 'variable.rename', label: 'Rename', onSelect: () => setRenaming(variable.id)},
      ] as MenuItem[]),
      {id: 'variable.duplicate', label: many ? `Duplicate (${ids.length})` : 'Duplicate', onSelect: () => duplicate(ids)},
      {id: 'variable.group', label: 'New group from selection', onSelect: () => newGroup(ids)},
      {type: 'separator'},
      {id: 'variable.delete', label: many ? `Delete variables (${ids.length})` : 'Delete variable', danger: true, onSelect: () => removeVariables(ids)},
    ]);
  };
  const groupMenu = (event: ReactMouseEvent, path: string) => {
    const ids = collection.variableIds.filter(id => (doc.variables[id]?.name ?? '').startsWith(path + '/'));
    menu.open(event, [
      {id: 'group.rename', label: 'Rename group', onSelect: () => setRenamingGroup(path)},
      {id: 'group.ungroup', label: 'Ungroup', onSelect: () => run('Ungroup', d => renameGroup(d, collection.id, path, path.split('/').slice(0, -1).join('/')))},
      {type: 'separator'},
      {id: 'group.delete', label: `Delete group (${ids.length})`, danger: true, onSelect: () => removeVariables(ids)},
    ]);
  };
  const select = (id: string, event: {metaKey: boolean; ctrlKey: boolean; shiftKey: boolean}) => {
    setSelected(clickSelect(order, live, anchor, id, {toggle: event.metaKey || event.ctrlKey, range: event.shiftKey}));
    if (!event.shiftKey) setAnchor(id);
  };

  // Dragging rows: the selection (or the row) goes before the row it is dropped on, into that row's group; onto a
  // group's head, into that group. Dragging a mode's head puts it before the head it is dropped on.
  const dropRows = (ids: readonly string[], target: {kind: 'row'; id: string; after: boolean} | {kind: 'group'; path: string}) => {
    if (target.kind === 'group') {
      run('Move to group', d => moveToGroup(d, ids, target.path));
      return;
    }
    if (ids.includes(target.id)) return;
    const group = doc.variables[target.id]?.name.split('/').slice(0, -1).join('/') ?? '';
    const before = target.after ? collection.variableIds[collection.variableIds.indexOf(target.id) + 1] ?? null : target.id;
    run('Reorder variables', d => chain(d, each => moveToGroup(each, ids, group), each => reorderVariables(each, collection.id, ids, before)));
  };
  const dragData = (event: ReactDragEvent) => {
    try {
      return JSON.parse(event.dataTransfer.getData(ROW_DRAG) || 'null') as string[] | null;
    } catch {
      return null;
    }
  };

  // Enter in a value moves to the same mode in the next row (⇧ the row above), as Figma's table.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>('.dz-variables-cell.is-value');
    if (event.key === 'Enter' && cell && target.matches('input')) {
      const row = cell.closest<HTMLElement>('[data-variable]');
      const index = order.indexOf(row?.dataset.variable ?? '');
      const next = order[index + (event.shiftKey ? -1 : 1)];
      if (next) requestAnimationFrame(() => {
        const field = scroller.current?.querySelector<HTMLInputElement>(`[data-variable="${CSS.escape(next)}"] [data-mode-index="${cell.dataset.modeIndex}"] input`);
        field?.focus();
        field?.select();
      });
      return;
    }
    if (target.matches('input, textarea, [contenteditable]')) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && live.length) {
      event.preventDefault();
      removeVariables(live);
    } else if (event.key === 'Escape' && live.length) {
      event.stopPropagation();
      setSelected([]);
    } else if ((event.metaKey || event.ctrlKey) && event.code === 'KeyA') {
      event.preventDefault();
      setSelected(order);
    } else if ((event.metaKey || event.ctrlKey) && event.code === 'KeyD' && live.length) {
      event.preventDefault();
      duplicate(live);
    }
  };

  const resizer = (key: string, current: number, min: number) => (
    <span className="dz-variables-resize" role="separator" aria-orientation="vertical" aria-label="Column width" aria-valuenow={current}
      onDoubleClick={() => setWidths(({[key]: _gone, ...rest}) => rest)}
      onPointerDown={event => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => setWidths(each => ({...each, [key]: Math.round(Math.min(WIDTH_MAX, Math.max(min, current + next.clientX - startX)))}));
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          target.removeEventListener('pointercancel', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
      }} />
  );

  return (
    <div ref={root} className="dz-variables-table" style={style}>
      <div className="dz-variables-search">
        <TextInput value={query} onChange={setQuery} icon={<IconSearch />} placeholder="Search" aria-label="Search variables" appearance="quiet" onCancel={() => setQuery('')} />
      </div>
      <div ref={scroller} className="dz-variables-scroll" role="grid" aria-label="Variables" aria-multiselectable="true" tabIndex={-1} onKeyDown={onKeyDown}
        onFocus={event => {
          // Only a field typed into (a menu button's own menu would close on the scroll).
          const cell = (event.target as HTMLElement).matches('input, textarea') ? (event.target as HTMLElement).closest<HTMLElement>('[data-mode-index]') : null;
          if (cell) reveal(cell);
        }}>
        <div className="dz-variables-row is-head" role="row">
          <div className="dz-variables-cell is-name" role="columnheader">Name{resizer('name', nameWidth, 140)}</div>
          <div className="dz-variables-modes" ref={modesHead}>
            <div className="dz-variables-track">
              {modes.map((mode, index) => (
                <div key={mode.modeId} role="columnheader" data-mode-index={index}
                  className={`dz-variables-cell is-mode ${drop?.kind === 'mode' && drop.key === mode.modeId ? 'is-drop-before' : ''}`.trim()}
                  draggable={renamingMode !== mode.modeId}
                  onDragStart={event => {
                    event.dataTransfer.setData(MODE_DRAG, mode.modeId);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={event => {
                    if (!event.dataTransfer.types.includes(MODE_DRAG)) return;
                    event.preventDefault();
                    setDrop({kind: 'mode', key: mode.modeId});
                  }}
                  onDragLeave={() => setDrop(null)}
                  onDrop={event => {
                    const moving = event.dataTransfer.getData(MODE_DRAG);
                    setDrop(null);
                    if (moving && moving !== mode.modeId) run('Reorder modes', d => reorderMode(d, collection.id, moving, mode.modeId));
                  }}
                  onDoubleClick={() => setRenamingMode(mode.modeId)} onContextMenu={event => menu.open(event, modeItems(mode.modeId))}>
                  {renamingMode === mode.modeId
                    ? <NameField initial={mode.name} label="Mode name" onDone={value => {
                      setRenamingMode(null);
                      if (value && value.trim() !== mode.name) run('Rename mode', d => renameVariableMode(d, collection.id, mode.modeId, value));
                    }} />
                    : <>
                      <span className="dz-variables-mode-name" title={mode.name}>{mode.name}</span>
                      {modes.length > 1 && collection.defaultModeId === mode.modeId && <span className="dz-variables-default">default</span>}
                      <ModeMenuButton name={mode.name} items={() => modeItems(mode.modeId)} />
                    </>}
                  {resizer(mode.modeId, modeWidths[index], MODE_MIN)}
                </div>
              ))}
            </div>
          </div>
          <div className="dz-variables-cell is-add" role="columnheader">
            <IconButton label="Add mode" onClick={addMode}><IconPlus /></IconButton>
          </div>
        </div>
        <div className="dz-variables-rows" role="rowgroup"
          onClick={event => {
            if (event.target === event.currentTarget) setSelected([]);
          }}>
          {!collection.variableIds.length && <p className="dz-variables-note">This collection has no variables yet.</p>}
          {!!collection.variableIds.length && !rows.length && <p className="dz-variables-note">Nothing found.</p>}
          {rows.map(row => row.kind === 'group' ? (
            <div key={'g:' + row.path} role="row" aria-expanded={!folded.has(row.path)}
              className={`dz-variables-group ${drop?.kind === 'group' && drop.key === row.path ? 'is-drop-into' : ''}`.trim()}
              style={{'--dz-depth': row.depth} as CSSProperties}
              onContextMenu={event => groupMenu(event, row.path)}
              onDragOver={event => {
                if (!event.dataTransfer.types.includes(ROW_DRAG)) return;
                event.preventDefault();
                setDrop({kind: 'group', key: row.path});
              }}
              onDragLeave={() => setDrop(null)}
              onDrop={event => {
                const ids = dragData(event);
                setDrop(null);
                if (ids) dropRows(ids, {kind: 'group', path: row.path});
              }}>
              <button type="button" className="dz-variables-fold" aria-label={folded.has(row.path) ? `Expand group "${row.name}"` : `Collapse group "${row.name}"`}
                onClick={() => setFolded(each => {
                  const next = new Set(each);
                  if (next.has(row.path)) next.delete(row.path);
                  else next.add(row.path);
                  return next;
                })}>
                {folded.has(row.path) ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
              </button>
              {renamingGroup === row.path
                ? <NameField initial={row.path} label="Group name" onDone={value => {
                  setRenamingGroup(null);
                  if (value && value.trim() !== row.path) run('Rename group', d => renameGroup(d, collection.id, row.path, value));
                }} />
                : <span className="dz-variables-group-name" role="rowheader" onDoubleClick={() => setRenamingGroup(row.path)}>
                  {row.parents && <span className="dz-variables-group-parents">{row.parents} / </span>}
                  <strong>{row.name}</strong>
                  <span className="dz-variables-count">{row.count}</span>
                </span>}
            </div>
          ) : (
            <VariableRow key={row.variable.id} doc={doc} collection={collection} variable={row.variable} depth={row.depth} run={run}
              renaming={renaming === row.variable.id} selected={live.includes(row.variable.id)}
              drop={drop?.kind === 'row' && drop.key === row.variable.id ? (drop.after ? 'after' : 'before') : null}
              onRenamed={() => setRenaming(null)} onStartRename={() => setRenaming(row.variable.id)} onMenu={rowMenu}
              onSelect={event => select(row.variable.id, event)}
              onDragStart={event => {
                const ids = live.includes(row.variable.id) ? order.filter(id => live.includes(id)) : [row.variable.id];
                event.dataTransfer.setData(ROW_DRAG, JSON.stringify(ids));
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={event => {
                if (!event.dataTransfer.types.includes(ROW_DRAG)) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                setDrop({kind: 'row', key: row.variable.id, after: event.clientY > box.top + box.height / 2});
              }}
              onDragLeave={() => setDrop(null)}
              onDrop={event => {
                const ids = dragData(event);
                const box = event.currentTarget.getBoundingClientRect();
                setDrop(null);
                if (ids) dropRows(ids, {kind: 'row', id: row.variable.id, after: event.clientY > box.top + box.height / 2});
              }} />
          ))}
        </div>
      </div>
      <div className="dz-variables-hbar" aria-hidden={trackWidth <= modesViewport || undefined}>
        <div ref={bar} className="dz-variables-hbar-scroll" onScroll={shift}>
          <div style={{width: trackWidth, height: 1}} />
        </div>
      </div>
      <div className="dz-variables-foot">
        <Button icon={<IconPlus />} variant="ghost" {...createMenu.triggerProps}>Create variable</Button>
        {createMenu.element}
      </div>
      {editing && doc.variables[editing.id] && (
        <VariableEditor anchor={editing.anchor} variable={doc.variables[editing.id]} run={run} onClose={() => setEditing(null)} />
      )}
      {menu.element}
    </div>
  );
}

/** The "⋯" in a mode's head: the same menu as a right click on it. */
function ModeMenuButton({name, items}: {name: string; items: () => MenuItem[]}) {
  const trigger = useMenuTrigger({label: `Mode "${name}"`, items});
  return (
    <>
      <button type="button" className="dz-variables-mode-menu" aria-label={`Mode "${name}" actions`} {...trigger.triggerProps}><IconMore size={14} /></button>
      {trigger.element}
    </>
  );
}

/** "Edit variable": its name and description, as Figma's variable panel (scoping and code syntax need fields
 *  the model does not have yet). */
function VariableEditor({anchor, variable, run, onClose}: {anchor: Element; variable: Variable; run: Run; onClose: () => void}) {
  const [description, setDescription] = useState(variable.description ?? '');
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-start" aria-label="Edit variable" className="dz-variables-editor">
      <div className="dz-variables-editor-body">
        <h3 className="dz-variables-editor-title">Edit variable</h3>
        <label className="dz-variables-editor-field">
          <span>Name</span>
          <NameField initial={variable.name} label="Variable name" keepOpen onDone={value => {
            if (value && value.trim() !== variable.name) run('Rename variable', d => renameVariable(d, variable.id, value));
          }} />
        </label>
        <label className="dz-variables-editor-field">
          <span>Description</span>
          <TextArea value={description} onChange={setDescription} aria-label="Variable description"
            onBlur={() => description !== (variable.description ?? '') && run('Variable description', d => describeVariable(d, variable.id, description))} />
        </label>
      </div>
    </Popover>
  );
}

type RowProps = {
  doc: DesignDocument;
  collection: VariableCollection;
  variable: Variable;
  depth: number;
  run: Run;
  renaming: boolean;
  selected: boolean;
  drop: 'before' | 'after' | null;
  onRenamed: () => void;
  onStartRename: () => void;
  onMenu: (event: ReactMouseEvent, variable: Variable) => void;
  onSelect: (event: ReactMouseEvent) => void;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
};

function VariableRow({doc, collection, variable, depth, run, renaming, selected, drop, onRenamed, onStartRename, onMenu, onSelect, ...drag}: RowProps) {
  const Icon = TYPE_ICONS[variable.type];
  return (
    <div className={`dz-variables-row ${selected ? 'is-selected' : ''} ${drop ? `is-drop-${drop}` : ''}`.trim()} role="row" aria-selected={selected}
      data-variable={variable.id} style={{'--dz-depth': depth} as CSSProperties}
      onDragOver={drag.onDragOver} onDragLeave={drag.onDragLeave} onDrop={drag.onDrop}
      onContextMenu={event => {
        if (!(event.target as Element).closest('input, .dz-variables-cell.is-value')) onMenu(event, variable);
      }}>
      <div className="dz-variables-cell is-name" role="rowheader" draggable={!renaming} onDragStart={drag.onDragStart}
        onClick={event => {
          if (!(event.target as Element).closest('input')) onSelect(event);
        }}
        onDoubleClick={onStartRename}>
        <span className="dz-variables-type" title={TYPE_LABELS[variable.type]}><Icon /></span>
        {renaming
          ? <NameField initial={variable.name} label="Variable name" onDone={value => {
            onRenamed();
            if (value && value.trim() !== variable.name) run('Rename variable', d => renameVariable(d, variable.id, value));
          }} />
          : <span className="dz-variables-name" title={variable.description ? `${variable.name}\n${variable.description}` : variable.name}>{leafName(variable.name)}</span>}
      </div>
      <div className="dz-variables-modes">
        <div className="dz-variables-track">
          {collection.modes.map((mode, index) => (
            <div key={mode.modeId} className="dz-variables-cell is-value" role="gridcell" data-mode-index={index}>
              <ValueCell doc={doc} variable={variable} modeId={mode.modeId} run={run} />
            </div>
          ))}
        </div>
      </div>
      <div className="dz-variables-cell is-add" />
    </div>
  );
}

function ValueCell({doc, variable, modeId, run}: {doc: DesignDocument; variable: Variable; modeId: string; run: Run}) {
  const value = variable.valuesByMode[modeId];
  const set = (next: VariableValue, label = 'Variable value') => run(label, d => setVariableValue(d, variable.id, modeId, next), `variable:${variable.id}:${modeId}`);
  const aliasMenu = useMenuTrigger({
    label: 'Apply variable',
    minWidth: 200,
    items: () => aliasItems(doc, variable, modeId, value, set),
  });
  const cellMenu = useContextMenu();
  let editor: ReactNode;
  if (isAlias(value)) {
    const target = doc.variables[value.id];
    const resolved = resolveVariable(doc, variable.id, modeId);
    editor = (
      <span className="dz-variables-alias" title={target ? `${target.name} · ${doc.variableCollections[target.collectionId]?.name ?? ''}` : undefined}>
        {variable.type === 'COLOR' && resolved && typeof resolved === 'object' && <ColorSwatch color={resolved as RGBA} size={14} />}
        <span className="dz-variables-alias-name">{target ? leafName(target.name) : 'Deleted variable'}</span>
        <button type="button" className="dz-variables-unlink" aria-label="Detach variable"
          onClick={() => resolved !== undefined && set(resolved, 'Detach variable')}><IconClose size={12} /></button>
      </span>
    );
  } else if (variable.type === 'COLOR') {
    const color = (value ?? {r: 0, g: 0, b: 0, a: 1}) as RGBA;
    editor = (
      <span className="dz-variables-color">
        <ColorSwatch color={color} size={14} aria-label={`Color ${colorHex(color)}`} />
        <HexInput color={color} onCommit={next => set(next)} />
        {color.a < 1 && <span className="dz-variables-alpha">{Math.round(color.a * 100)}%</span>}
      </span>
    );
  } else if (variable.type === 'FLOAT') {
    editor = <NumberField className="dz-variables-number" aria-label="Value" value={typeof value === 'number' ? value : 0} precision={2} onChange={next => set(next)} />;
  } else if (variable.type === 'STRING') {
    editor = <StringInput value={typeof value === 'string' ? value : ''} onCommit={next => set(next)} />;
  } else {
    editor = <Toggle checked={value === true} onChange={next => set(next)} aria-label="Value">{value === true ? 'True' : 'False'}</Toggle>;
  }
  return (
    <>
      <span className="dz-variables-value" onContextMenu={event => {
        if ((event.target as Element).closest('input')) return;
        cellMenu.open(event, [
          {type: 'submenu', id: 'alias', label: 'Apply variable', icon: <IconLink />, items: aliasItems(doc, variable, modeId, value, set).filter(item => !('id' in item && item.id === 'alias.detach'))},
          ...(isAlias(value) ? [{id: 'alias.detach', label: 'Detach variable', onSelect: () => {
            const resolved = resolveVariable(doc, variable.id, modeId);
            if (resolved !== undefined) set(resolved, 'Detach variable');
          }}] as MenuItem[] : []),
        ]);
      }}>{editor}</span>
      <button type="button" className="dz-variables-link" tabIndex={-1} aria-label="Apply variable" {...aliasMenu.triggerProps}><IconLink /></button>
      {aliasMenu.element}
      {cellMenu.element}
    </>
  );
}

/** A variable's new description (the shared operations have none: the variable is written whole, one undo step). */
function describeVariable(doc: DesignDocument, id: string, description: string): VariableEdit {
  const variable = doc.variables[id];
  if (!variable) return {doc, changed: new Set()};
  return {doc: {...doc, variables: {...doc.variables, [id]: {...variable, description}}}, changed: new Set([id])};
}

function aliasItems(doc: DesignDocument, variable: Variable, modeId: string, value: VariableValue | undefined, set: (next: VariableValue, label?: string) => unknown): MenuItem[] {
  const items: MenuItem[] = [];
  if (isAlias(value)) {
    const resolved = resolveVariable(doc, variable.id, modeId);
    items.push({id: 'alias.detach', label: 'Detach', description: 'Keep the current value', onSelect: () => resolved !== undefined && set(resolved, 'Detach variable')}, {type: 'separator'});
  }
  const candidates = Object.values(doc.variables).filter(other => other.id !== variable.id && other.type === variable.type && !wouldCreateAliasCycle(doc, variable.id, other.id));
  if (!candidates.length) {
    items.push({type: 'label', label: 'No variables of the same type'});
    return items;
  }
  let lastCollection: string | null = null;
  for (const other of candidates) {
    if (other.collectionId !== lastCollection) {
      lastCollection = other.collectionId;
      items.push({type: 'label', label: doc.variableCollections[other.collectionId]?.name ?? 'Collection'});
    }
    const resolved = resolveVariable(doc, other.id);
    items.push({
      id: `alias.${other.id}`,
      label: other.name,
      icon: variable.type === 'COLOR' && resolved && typeof resolved === 'object' ? <ColorSwatch color={resolved as RGBA} size={14} /> : undefined,
      checked: isAlias(value) && value.id === other.id,
      onSelect: () => set({type: 'VARIABLE_ALIAS', id: other.id}, 'Link to variable'),
    });
  }
  return items;
}

function HexInput({color, onCommit}: {color: RGBA; onCommit: (color: RGBA) => void}) {
  const shown = colorHex(color);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  return <TextInput className="dz-variables-hex" appearance="quiet" value={draft} onChange={setDraft} aria-label="Color" maxLength={9}
    onCancel={() => setDraft(shown)}
    onCommit={text => {
      const next = parseHex(text);
      if (next) onCommit(text.replace(/^#/, '').length === 8 ? next : {...next, a: color.a});
      else setDraft(shown);
    }} />;
}

function StringInput({value, onCommit}: {value: string; onCommit: (value: string) => void}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <TextInput appearance="quiet" value={draft} onChange={setDraft} aria-label="Value" onCancel={() => setDraft(value)} onCommit={next => next !== value && onCommit(next)} />;
}

/** A name typed in place: Enter or a click away keeps it, Escape leaves the old one. `keepOpen` (a field in a panel
 *  that stays) takes every commit instead of only the first. */
function NameField({initial, label, onDone, keepOpen = false}: {initial: string; label: string; onDone: (value: string | null) => void; keepOpen?: boolean}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    if (!keepOpen) done.current = true;
    else if (next === null) setValue(initial);
    onDone(next?.trim() ? next : null);
  };
  useLayoutEffect(() => {
    input.current?.focus({preventScroll: true});
    input.current?.select();
  }, []);
  return <TextInput className="dz-variables-rename" value={value} onChange={setValue} inputRef={input} aria-label={label}
    onCommit={finish} onCancel={() => finish(null)} onBlur={event => finish(event.currentTarget.value)} />;
}
