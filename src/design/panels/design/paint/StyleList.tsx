import {useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import type {DesignDocument, Effect, Paint, Style, StyleId, VariableId} from '../../../../../shared/design/types';
import {groupStyles, styleDisplayName, type StyleGroup} from '../../../../../shared/design/styles';
import {resolveVariable} from '../../../../../shared/design/variables';
import {useDesignStore, useStoreApi} from '../../../engine/useDesignStore';
import {Button, IconButton} from '../../../ui/Button';
import {FloatingPanel, besidePanel} from '../../../ui/ColorPicker';
import {IconClose, IconEffects, IconMore, IconPlus, IconSearch} from '../../../ui/icons';
import {Menu} from '../../../ui/Menu';
import type {Rect} from '../../../ui/position';
import {TextInput} from '../../../ui/TextInput';
import {useCommitter} from './editing';
import {EffectRows} from './EffectRows';
import {PaintPicker} from './PaintPicker';
import {PaintRows} from './PaintRows';
import {newFill, paintPreview, reorderRows, removeAt, replaceAt, rgbaCss} from './paints';
import {deleteStyle, renameStyle, setStyleEffects, setStylePaints, stylesOfType, usersOf} from './style-ops';

// Colour and effect styles: the list the "Styles" button and the picker's "Libraries" tab show
// (folders from "/" in names, colour variables after the styles), with "Edit", "Rename"
// and "Delete" on each style, and the style editor (every user follows its edits).

export type StyleType = 'FILL' | 'EFFECT';

/** The swatch of a colour style: its top visible paint. */
export function StyleSwatch({style, size = 16}: {style: Style; size?: number}) {
  if (style.type === 'EFFECT') return <span className="dz-style-glyph" style={{width: size, height: size}}><IconEffects size={size} /></span>;
  const paint = [...(style.paints ?? [])].reverse().find(each => each.visible !== false);
  return <span className="dz-style-swatch" style={{'--dz-swatch': paint ? paintPreview(paint) : 'transparent', '--dz-swatch-alpha': paint?.type === 'SOLID' ? paint.opacity : 1, width: size, height: size} as CSSProperties} aria-hidden="true" />;
}

type ColorVariable = {id: VariableId; name: string; collection: string; color: string};

function colorVariables(doc: DesignDocument): ColorVariable[] {
  const out: ColorVariable[] = [];
  for (const variable of Object.values(doc.variables)) {
    if (variable.type !== 'COLOR') continue;
    const value = resolveVariable(doc, variable.id);
    const color = value && typeof value === 'object' && 'r' in value ? rgbaCss(value) : 'transparent';
    out.push({id: variable.id, name: variable.name, collection: doc.variableCollections[variable.collectionId]?.name ?? 'Variables', color});
  }
  return out;
}

export type StyleListProps = {
  type: StyleType;
  currentStyleId?: StyleId | null;
  onApply: (styleId: StyleId, row: HTMLElement) => void;
  /** Colour variables after the styles; a click binds one. */
  onBindVariable?: (variableId: VariableId) => void;
  currentVariableId?: VariableId | null;
  query?: string;
  /** Opens the style editor (StylesPopover keeps it). */
  onEdit: (styleId: StyleId, row: HTMLElement) => void;
  empty?: ReactNode;
  /** The file's own styles only (the "Color styles" section): a shared library's are applied from pickers, edited in its file. */
  localOnly?: boolean;
};

export function StyleList({type, currentStyleId, onApply, onBindVariable, currentVariableId, query = '', onEdit, empty, localOnly = false}: StyleListProps) {
  const store = useStoreApi();
  const styles = useDesignStore(state => state.doc.styles, Object.is, {slice: 'doc'});
  const variablesTable = useDesignStore(state => (onBindVariable ? state.doc.variables : null), Object.is, {slice: 'doc'});
  const needle = query.trim().toLowerCase();
  const list = useMemo(() => Object.values(styles).filter(style => style.type === type && !(localOnly && style.remote) && (!needle || style.name.toLowerCase().includes(needle))), [styles, type, needle, localOnly]);
  const grouped = useMemo(() => groupStyles(list), [list]);
  const variables = useMemo(() => (variablesTable ? colorVariables(store.getState().doc).filter(each => !needle || each.name.toLowerCase().includes(needle)) : []), [variablesTable, store, needle]);
  const [renaming, setRenaming] = useState<StyleId | null>(null);
  const [menu, setMenu] = useState<{styleId: StyleId; anchor: Element} | null>(null);

  if (!list.length && !variables.length) return <div className="dz-style-empty">{needle ? 'Nothing found.' : empty}</div>;

  const rename = (styleId: StyleId, name: string) => {
    setRenaming(null);
    store.transact('Rename style', tx => renameStyle(tx, styleId, name));
  };
  const renderGroup = (group: StyleGroup, depth: number): ReactNode => (
    <div key={group.path || '/'} className="dz-style-group">
      {group.path && <div className="dz-style-folder" style={{'--dz-depth': depth - 1} as CSSProperties}>{group.name}</div>}
      {group.styles.map(style => (
        <div key={style.id} className={`dz-style-item ${style.id === currentStyleId ? 'is-current' : ''}`} style={{'--dz-depth': depth} as CSSProperties}>
          {renaming === style.id ? (
            <div className="dz-style-rename">
              <StyleSwatch style={style} />
              <RenameField initial={style.name} onCommit={name => rename(style.id, name)} onCancel={() => setRenaming(null)} />
            </div>
          ) : (
            <>
              <button type="button" className="dz-style-apply" aria-current={style.id === currentStyleId || undefined} onClick={event => onApply(style.id, event.currentTarget.closest('.dz-style-item') as HTMLElement)}
                onContextMenu={event => {
                  event.preventDefault();
                  setMenu({styleId: style.id, anchor: event.currentTarget});
                }}>
                <StyleSwatch style={style} />
                <span className="dz-style-name">{styleDisplayName(style)}</span>
              </button>
              <IconButton label="Style actions" className="dz-style-more" onClick={event => setMenu({styleId: style.id, anchor: event.currentTarget})}><IconMore /></IconButton>
            </>
          )}
        </div>
      ))}
      {group.groups.map(child => renderGroup(child, depth + 1))}
    </div>
  );

  return (
    <div className="dz-style-list">
      {list.length > 0 && (
        <>
          {onBindVariable && <div className="dz-style-heading">Styles</div>}
          {renderGroup(grouped, 0)}
        </>
      )}
      {variables.length > 0 && (
        <>
          <div className="dz-style-heading">Variables</div>
          {variables.map(variable => (
            <div key={variable.id} className={`dz-style-item ${variable.id === currentVariableId ? 'is-current' : ''}`}>
              <button type="button" className="dz-style-apply" onClick={() => onBindVariable?.(variable.id)} aria-current={variable.id === currentVariableId || undefined}>
                <span className="dz-style-swatch is-variable" style={{'--dz-swatch': variable.color, '--dz-swatch-alpha': 1, width: 16, height: 16} as CSSProperties} aria-hidden="true" />
                <span className="dz-style-name">{variable.name}</span>
                <span className="dz-style-meta">{variable.collection}</span>
              </button>
            </div>
          ))}
        </>
      )}
      {menu && (
        <Menu anchor={{element: menu.anchor}} placement="bottom-end" onClose={() => setMenu(null)} aria-label="Style actions" items={styles[menu.styleId]?.remote ? [
          // A shared library's style (docs/design-tool.md §Teams): read-only here, changed in the library's file.
          {id: 'library', label: 'Library style: changed in its file', disabled: true, onSelect: () => {}},
        ] : [
          {id: 'edit', label: 'Edit style', onSelect: () => onEdit(menu.styleId, menu.anchor.closest('.dz-style-item') as HTMLElement ?? menu.anchor)},
          {id: 'rename', label: 'Rename', onSelect: () => setRenaming(menu.styleId)},
          {type: 'separator'},
          {id: 'delete', label: 'Delete style', danger: true, onSelect: () => store.transact('Delete style', tx => deleteStyle(tx, menu.styleId))},
        ]} />
      )}
    </div>
  );
}

function RenameField({initial, onCommit, onCancel}: {initial: string; onCommit: (name: string) => void; onCancel: () => void}) {
  const [value, setValue] = useState(initial);
  return <TextInput aria-label="Style name" value={value} autoFocus selectOnFocus onChange={setValue} onCommit={onCommit} onCancel={onCancel} onBlur={onCancel} />;
}

// ── The "Styles" popover ─────────────────────────────────────────────────────────────────────────

export type StylesPopoverProps = {
  anchor: Element | Rect;
  trigger?: Element | null;
  onClose: () => void;
  type: StyleType;
  title: string;
  currentStyleId?: StyleId | null;
  onApply: (styleId: StyleId) => void;
  /** Makes a style from the selection; absent when there is nothing to make it from. */
  onCreate?: (name: string) => void;
  onBindVariable?: (variableId: VariableId) => void;
  currentVariableId?: VariableId | null;
};

export function StylesPopover({anchor, trigger, onClose, type, title, currentStyleId, onApply, onCreate, onBindVariable, currentVariableId}: StylesPopoverProps) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{styleId: StyleId; anchor: Rect; row: Element} | null>(null);
  const create = () => {
    onCreate?.(name);
    setCreating(false);
    setName('');
  };
  return (
    <FloatingPanel anchor={anchor} trigger={trigger} onClose={onClose} aria-label={title} className="dz-styles-popover" layoutKey={creating}>
      <div className="dz-cp-header">
        <h2 className="dz-cp-title">{title}</h2>
        {onCreate && <IconButton label="Create style" pressed={creating} onClick={() => setCreating(value => !value)}><IconPlus /></IconButton>}
        <IconButton label="Close" tooltip={false} onClick={onClose}><IconClose /></IconButton>
      </div>
      {creating && onCreate && (
        <div className="dz-style-create">
          <TextInput aria-label="New style name" placeholder="For example, Brand/Primary" value={name} onChange={setName} autoFocus onCommit={create} onCancel={() => setCreating(false)} />
          <Button size={24} variant="primary" onClick={create}>Create</Button>
        </div>
      )}
      <div className="dz-style-search">
        <TextInput aria-label="Search styles" placeholder="Search" icon={<IconSearch />} value={query} onChange={setQuery} />
      </div>
      <div className="dz-styles-scroll">
        <StyleList type={type} currentStyleId={currentStyleId} onApply={onApply} onBindVariable={onBindVariable} currentVariableId={currentVariableId}
          query={query} onEdit={(styleId, row) => setEditing({styleId, anchor: besidePanel(row), row})}
          empty={onCreate ? 'No styles in this file yet. Click "+" to save the selection as a style.' : 'No styles in this file yet.'} />
      </div>
      {editing && <StyleEditor anchor={editing.anchor} trigger={editing.row} styleId={editing.styleId} onClose={() => setEditing(null)} />}
    </FloatingPanel>
  );
}

// ── The style editor ─────────────────────────────────────────────────────────────────────────────

export function StyleEditor({anchor, trigger, styleId, onClose}: {anchor: Element | Rect; trigger?: Element | null; styleId: StyleId; onClose: () => void}) {
  const store = useStoreApi();
  const style = useDesignStore(state => state.doc.styles[styleId], Object.is, {slice: 'doc'});
  const committer = useCommitter();
  // Users are found once: a drag in the editor then rewrites only them on each frame; a single
  // change rewrites the file's users through updateStyleUpdates.
  const found = useMemo(() => usersOf(store.getState().doc, styleId), [store, styleId]);
  const [open, setOpen] = useState<{index: number; anchor: Rect; row: Element} | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const images = useDesignStore(state => state.doc.images, Object.is, {slice: 'doc'});
  const variables = useDesignStore(state => state.doc.variables, Object.is, {slice: 'doc'});
  const doc = useMemo(() => ({images, variables}), [images, variables]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  if (!style) return null;

  const writePaints = (make: (paints: Paint[]) => Paint[]) => {
    const users = committer.active ? found : undefined;
    return (tx: Parameters<typeof setStylePaints>[0]) => {
      const current = tx.doc.styles[styleId];
      if (current?.paints) setStylePaints(tx, styleId, make(current.paints), users);
    };
  };
  const writeEffects = (make: (effects: Effect[]) => Effect[] | null) => {
    const users = committer.active ? found : undefined;
    return (tx: Parameters<typeof setStyleEffects>[0]) => {
      const current = tx.doc.styles[styleId];
      const next = current?.effects && make(current.effects);
      if (next) setStyleEffects(tx, styleId, next, users);
    };
  };
  const paints = style.paints ?? [];
  return (
    <FloatingPanel anchor={anchor} trigger={trigger} onClose={onClose} aria-label="Edit style" className="dz-style-editor" layoutKey={(style.paints?.length ?? 0) + (style.effects?.length ?? 0)}>
      <div className="dz-cp-header">
        <h2 className="dz-cp-title">{style.remote ? 'Library style' : 'Edit style'}</h2>
        <IconButton label="Close" tooltip={false} onClick={onClose}><IconClose /></IconButton>
      </div>
      {/* A shared library's style (docs/design-tool.md §Teams) is read-only here: it changes in the library's file. */}
      {style.remote && <p className="dz-style-remote-note">Changed in the library file; it arrives here with an update.</p>}
      <fieldset disabled={!!style.remote} className="dz-readonly-fieldset">
      <div className="dz-style-editor-body">
        <TextInput aria-label="Style name" value={draftName ?? style.name} onChange={setDraftName}
          onCommit={name => {
            setDraftName(null);
            store.transact('Rename style', tx => renameStyle(tx, styleId, name));
          }} onBlur={() => setDraftName(null)} />
        <div className="dz-style-editor-head">
          <span className="dz-cp-caption">{style.type === 'EFFECT' ? 'Effects' : 'Fills'}</span>
          {style.type === 'FILL' && (
            <IconButton label="Add fill" onClick={() => store.transact('Style', writePaints(list => [...list, newFill('RECTANGLE', list)]))}><IconPlus /></IconButton>
          )}
        </div>
        {style.type === 'FILL' ? (
          <PaintRows paints={paints} doc={doc} openIndex={open?.index ?? null} label="Style fills" committer={committer}
            onOpen={(index, row) => setOpen(current => (current?.index === index ? null : {index, anchor: besidePanel(row), row}))}
            onPaint={(index, paint, label) => committer.set(label, writePaints(list => replaceAt(list, index, paint)))}
            onRemove={index => store.transact('Style', writePaints(list => (list.length > 1 ? removeAt(list, index) : list)))}
            onReorder={(from, to) => store.transact('Reorder fills', writePaints(list => reorderRows(list, from, to)))} />
        ) : (
          <EffectRows effects={style.effects ?? []} committer={committer} label="Style effects"
            write={make => writeEffects(make)} />
        )}
      </div>
      </fieldset>
      {open && paints[open.index] && (
        <PaintPicker anchor={open.anchor} trigger={open.row} onClose={() => setOpen(null)} paint={paints[open.index]} label="Style color" committer={committer}
          write={paint => writePaints(list => replaceAt(list, open.index, paint))} />
      )}
    </FloatingPanel>
  );
}

export {stylesOfType};
