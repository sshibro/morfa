import '../../../styles/panel-paint.css';
import {memo, useCallback, useMemo, useState, useSyncExternalStore} from 'react';
import type {NodeId, NodeType, Paint, Style, StyleId} from '../../../../../shared/design/types';
import {styleDisplayName} from '../../../../../shared/design/styles';
import type {EditorState} from '../../../engine/store';
import {useDesignStore, useStoreApi} from '../../../engine/useDesignStore';
import {IconButton} from '../../../ui/Button';
import {besidePanel} from '../../../ui/ColorPicker';
import {IconDetachStyle, IconStyles} from '../../../ui/icons';
import {PanelSection} from '../../../ui/PanelSection';
import type {Rect} from '../../../ui/position';
import type {SectionProps} from '../sections';
import {applyTextOp} from '../../../engine/commands/text';
import {subscribeTextEditing, textEditingSnapshot, type TextEditingSnapshot} from '../../../engine/text-editor/registry';
import {useCommitter, writePaints, type Change} from './editing';
import {PaintPicker} from './PaintPicker';
import {PaintRows, RowNote} from './PaintRows';
import {MIXED, commonList, newFill, newStroke, removeAt, reorderRows, replaceAt, replacingFill, takesFills, takesStrokes, unbound, type PaintField} from './paints';
import {StrokeControls} from './StrokeControls';
import {StyleEditor, StyleList, StyleSwatch, StylesPopover} from './StyleList';
import {applyStyleTo, bindPaint, createStyleFrom, detachStyleFrom, STYLE_FIELD} from './style-ops';
import {editsPartOfText, textPaintsOf} from './text-paints';

// "Fill" (70) and "Stroke" (80) of the "Design" tab: the paint list of the selection (top paint
// first), "+" with Figma's defaults, drag to reorder, the picker per row, the colour style the list
// follows (with "Detach" and the style editor), and "Click + to replace mixed fills"
// when the layers differ. On texts "Fill" is the text colour and goes through the text commands
// (`applyTextOp`): while a text is edited, to the selected characters or the caret's next ones.

type PaintData = {
  targets: NodeId[];
  lists: (readonly Paint[] | 'mixed')[];
  styleIds: (StyleId | undefined)[];
  types: NodeType[];
};

export const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
const sameData = (a: PaintData, b: PaintData) => sameItems(a.targets, b.targets) && sameItems(a.lists, b.lists) && sameItems(a.styleIds, b.styleIds) && sameItems(a.types, b.types);

function selectPaintData(state: EditorState, ids: readonly NodeId[], field: PaintField, editing: TextEditingSnapshot): PaintData {
  const data: PaintData = {targets: [], lists: [], styleIds: [], types: []};
  const takes = field === 'fills' ? takesFills : takesStrokes;
  for (const id of ids) {
    const node = state.doc.nodes[id];
    if (!node || !takes(node.type)) continue;
    data.targets.push(id);
    data.lists.push(field === 'fills' && node.type === 'TEXT' ? textPaintsOf(node, editing) : node[field]);
    data.styleIds.push(node[STYLE_FIELD[field]]);
    data.types.push(node.type);
  }
  return data;
}

/** The text editor's selection when it edits one of these layers (the fill then shows its colour). */
function useTextEditing(ids: readonly NodeId[], field: PaintField): TextEditingSnapshot {
  const store = useStoreApi();
  const subscribe = useCallback((listener: () => void) => subscribeTextEditing(store, listener), [store]);
  const snapshot = useSyncExternalStore(subscribe, () => textEditingSnapshot(store), () => null);
  return field === 'fills' && snapshot && ids.includes(snapshot.id) ? snapshot : null;
}

type Open = {index: number; anchor: Rect; row: Element; tab: 'custom' | 'libraries'};

export const PaintSection = memo(function PaintSection({ids, field}: {ids: readonly NodeId[]; field: PaintField}) {
  const store = useStoreApi();
  const editing = useTextEditing(ids, field);
  const selector = useCallback((state: EditorState) => selectPaintData(state, ids, field, editing), [ids, field, editing]);
  const data = useDesignStore(selector, sameData, {slice: 'doc'});
  const images = useDesignStore(state => state.doc.images, Object.is, {slice: 'doc'});
  const variables = useDesignStore(state => state.doc.variables, Object.is, {slice: 'doc'});
  const tables = useMemo(() => ({images, variables}), [images, variables]);
  const committer = useCommitter();
  const [open, setOpen] = useState<Open | null>(null);
  const [stylesAt, setStylesAt] = useState<{anchor: Rect; row: Element} | null>(null);
  const [editingStyle, setEditingStyle] = useState<{anchor: Rect; row: Element} | null>(null);

  const {targets} = data;
  // Part of a text being edited: styles, variables and canvas editing apply to whole layers only.
  const partial = useDesignStore(state => !!editing && editsPartOfText(state.doc.nodes[editing.id], editing), Object.is, {slice: 'doc'});
  const list = useMemo(() => {
    const known = data.lists.filter((each): each is readonly Paint[] => each !== MIXED);
    return known.length !== data.lists.length ? MIXED : commonList(known);
  }, [data.lists]);
  const styleId = useMemo(() => {
    const first = data.styleIds[0];
    return !partial && first && data.styleIds.every(each => each === first) ? first : null;
  }, [data.styleIds, partial]);
  const style = useDesignStore(state => (styleId ? state.doc.styles[styleId] : undefined), Object.is, {slice: 'doc'});
  const single = targets.length === 1 && !partial ? targets[0] : null;
  // The layer's size matters only to an open picker (image crop, gradient handles): resizing the layer
  // with the picker closed re-renders nothing here.
  const pickerOpen = open !== null;
  const box = useDesignStore(state => {
    const node = single && pickerOpen ? state.doc.nodes[single] : undefined;
    return node ? `${node.width}x${node.height}` : '';
  }, Object.is, {slice: 'doc'});
  const size = useMemo(() => {
    const [width, height] = box.split('x').map(Number);
    return box ? {width, height} : undefined;
  }, [box]);

  // Texts take their colour through the text commands (the edited range, the caret, or whole texts).
  const textOnly = field === 'fills' && data.types.length > 0 && data.types.every(type => type === 'TEXT');
  const write = useCallback((make: Parameters<typeof writePaints>[3]): Change => {
    if (!textOnly) return tx => writePaints(tx, targets, field, make);
    return {
      run(gesture, label) {
        const node = store.getState().doc.nodes[targets[0]];
        const shown = list === MIXED ? [] : [...list];
        const fills = node && make(shown, node);
        if (fills) applyTextOp(store, {kind: 'fills', fills}, label, {ids: targets, gesture: gesture ?? undefined});
      },
    };
  }, [textOnly, targets, field, store, list]);

  const fills = field === 'fills';
  const title = fills ? 'Fill' : 'Stroke';
  const noun = fills ? 'fill' : 'stroke';
  if (!targets.length) return null;

  const add = () => {
    setOpen(null);
    // Differing lists are replaced by one paint for every layer (they agree afterwards, as in Figma).
    const replacing = fills ? replacingFill(data.types) : newStroke();
    committer.set(fills ? 'Fill' : 'Stroke', write((paints, node) => {
      if (list === MIXED) return [structuredClone(replacing)];
      return [...paints, fills ? newFill(node.type, paints) : newStroke()];
    }));
  };
  const onPaint = (index: number, paint: Paint, label: string) => committer.set(label, write(paints => (paints[index] ? replaceAt(paints, index, paint) : null)));
  const onRemove = (index: number) => {
    setOpen(null);
    committer.set(`Delete ${noun}`, write(paints => removeAt(paints, index)));
  };
  const onReorder = (from: number, to: number) => {
    setOpen(null);
    committer.set(fills ? 'Reorder fills' : 'Reorder strokes', write(paints => reorderRows(paints, from, to)));
  };
  const openRow = (index: number, row: HTMLElement, tab: 'custom' | 'libraries' = 'custom') =>
    setOpen(current => (current?.index === index ? null : {index, anchor: besidePanel(row), row, tab}));

  const applyStyle = (id: StyleId) => {
    setOpen(null);
    store.transact('Style', tx => applyStyleTo(tx, targets, id, field));
  };
  const createStyle = (name: string) => store.transact('New style', tx => {
    createStyleFrom(tx, targets, field, name);
  });
  const detach = () => store.transact('Detach style', tx => detachStyleFrom(tx, targets, field));
  const canCreate = list !== MIXED && list.length > 0 && !partial;
  const paints = list === MIXED ? [] : list;
  const empty = list !== MIXED && list.length === 0 && !style;
  const openPaint = open && paints[open.index] ? paints[open.index] : null;
  const boundId = openPaint?.type === 'SOLID' ? openPaint.boundVariables?.color?.id ?? null : null;

  return (
    <PanelSection title={title} empty={empty} onAdd={add} addLabel={`Add ${noun}`}
      actions={!partial && (
        <IconButton label={fills ? 'Fill styles and variables' : 'Stroke styles and variables'} pressed={!!stylesAt}
          onClick={event => {
            const row = event.currentTarget;
            setStylesAt(current => (current ? null : {anchor: besidePanel(row), row}));
          }}>
          <IconStyles />
        </IconButton>
      )}>
      {style ? (
        <StyleRow style={style} onEdit={row => setEditingStyle(current => (current ? null : {anchor: besidePanel(row), row}))}
          onSwap={row => setStylesAt(current => (current ? null : {anchor: besidePanel(row), row}))} onDetach={detach} />
      ) : list === MIXED ? (
        <RowNote>{fills ? 'Click "+" to replace mixed fills' : 'Click "+" to replace mixed strokes'}</RowNote>
      ) : (
        paints.length > 0 && (
          <PaintRows paints={paints} doc={tables} openIndex={open?.index ?? null} onOpen={openRow} onPaint={onPaint} onRemove={onRemove} onReorder={onReorder}
            committer={committer} label={title} binding={partial ? null : {ids: targets, field}} />
        )
      )}
      {!fills && (paints.length > 0 || style || list === MIXED) && <StrokeControls ids={targets} committer={committer} />}
      {open && openPaint && (
        <PaintPicker anchor={open.anchor} trigger={open.row} onClose={() => setOpen(null)} paint={openPaint} label={title} committer={committer}
          write={paint => write(current => (current[open.index] ? replaceAt(current, open.index, paint) : null))}
          canvasTarget={single ? {nodeId: single, field, index: open.index} : null} box={size} initialTab={open.tab}
          onCreateStyle={canCreate ? () => {
            setOpen(null);
            createStyle('');
          } : undefined}
          boundVariable={boundId ? {name: variables[boundId]?.name ?? 'Variable', onDetach: () => openPaint.type === 'SOLID' && onPaint(open.index, unbound(openPaint), 'Detach variable')} : null}
          libraries={(
            <StyleList type="FILL" currentStyleId={styleId} onApply={applyStyle} currentVariableId={boundId}
              onBindVariable={variableId => store.transact('Variable', tx => bindPaint(tx, targets, field, open.index, variableId))}
              onEdit={(_, row) => setEditingStyle({anchor: besidePanel(row), row})}
              empty="No color styles or variables in this file yet." />
          )} />
      )}
      {stylesAt && (
        <StylesPopover anchor={stylesAt.anchor} trigger={stylesAt.row} onClose={() => setStylesAt(null)} type="FILL" title={fills ? 'Fill styles' : 'Stroke styles'}
          currentStyleId={styleId} onApply={id => {
            applyStyle(id);
            setStylesAt(null);
          }}
          onCreate={canCreate ? createStyle : undefined}
          onBindVariable={variableId => {
            store.transact('Variable', tx => bindPaint(tx, targets, field, 'all', variableId));
            setStylesAt(null);
          }} />
      )}
      {editingStyle && style && <StyleEditor anchor={editingStyle.anchor} trigger={editingStyle.row} styleId={style.id} onClose={() => setEditingStyle(null)} />}
    </PanelSection>
  );
});

/** The row a styled list shows instead of its paints: the style's swatch and name, "Detach". */
export function StyleRow({style, onEdit, onSwap, onDetach}: {style: Style; onEdit: (row: HTMLElement) => void; onSwap: (row: HTMLElement) => void; onDetach: () => void}) {
  return (
    <div className="dz-paint-style-row">
      <div className="dz-paint-field">
        <button type="button" className="dz-style-row-swatch" aria-label="Edit style" onClick={event => onEdit(event.currentTarget.closest('.dz-paint-style-row') as HTMLElement)}>
          <StyleSwatch style={style} size={14} />
        </button>
        <button type="button" className="dz-style-row-name" onClick={event => onSwap(event.currentTarget.closest('.dz-paint-style-row') as HTMLElement)} title={style.name}>
          {styleDisplayName(style)}
        </button>
      </div>
      <IconButton label="Detach style" onClick={onDetach}><IconDetachStyle /></IconButton>
    </div>
  );
}

/** Sections re-render only when the selection changes; everything else they read from the store.
 *  A new selection starts afresh (pickers and popovers close, as in Figma): the body is keyed by it. */
const sameIds = (a: SectionProps, b: SectionProps) => sameItems(a.ids, b.ids);

export const FillSection = memo(function FillSection({ids}: SectionProps) {
  return <PaintSection key={ids.join(',')} ids={ids} field="fills" />;
}, sameIds);

export const StrokeSection = memo(function StrokeSection({ids}: SectionProps) {
  return <PaintSection key={ids.join(',')} ids={ids} field="strokes" />;
}, sameIds);
