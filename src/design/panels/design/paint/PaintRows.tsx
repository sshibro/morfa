import {memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref} from 'react';
import type {DesignDocument, NodeId, Paint} from '../../../../../shared/design/types';
import {useEditorServices} from '../../../editor/services';
import {handToDocument, isUndoKey} from '../../../engine/keyboard';
import {useDesignStore} from '../../../engine/useDesignStore';
import {IconButton} from '../../../ui/Button';
import {IconEye, IconEyeOff, IconGrip, IconMinus} from '../../../ui/icons';
import {VariableBindButton, VariableChip, bindingState, type VariableBindingState, type VariableBindTarget} from '../../variables/VariableBindButton';
import {NumberField} from '../../../ui/NumberField';
import {parseHex, percent, toHex} from './color';
import type {Committer} from './editing';
import {deepEqual, displayOrder, paintLabel, paintPreview, rgbaCss, rowIndex, unbound, type PaintField} from './paints';
import {useRowReorder} from './reorder';

// The rows of a paint list (fills, strokes, a style's paints): the top paint first, each with its
// swatch (opens the picker), hex or kind, opacity, visibility and "−". Rows are memoized one by one,
// so editing one paint re-renders one row.

export type PaintRowsProps = {
  /** Model order: index 0 is drawn at the bottom. */
  paints: readonly Paint[];
  doc: Pick<DesignDocument, 'images'>;
  /** Index (model order) whose picker is open. */
  openIndex: number | null;
  onOpen: (index: number, row: HTMLElement) => void;
  /** Replace one paint (one step, or a frame of an open gesture). */
  onPaint: (index: number, paint: Paint, label: string) => void;
  onRemove: (index: number) => void;
  /** Rows are top-first; the owner turns them into model order. */
  onReorder: (fromRow: number, toRow: number) => void;
  committer: Committer;
  label: string;
  /** Layers whose paints these are: solid rows then take colour variables (the shared
   *  VariableBindButton and chip, panels/variables). Absent for a style's paints. */
  binding?: {ids: readonly NodeId[]; field: PaintField} | null;
};

export function PaintRows({paints, doc, openIndex, onOpen, onPaint, onRemove, onReorder, committer, label, binding}: PaintRowsProps) {
  const {listRef, gripProps} = useRowReorder(onReorder);
  const rows = displayOrder(paints);
  return (
    <div ref={listRef} className="dz-paint-list" role="list" aria-label={label}>
      {rows.map((paint, row) => {
        const index = rowIndex(row, paints.length);
        return (
          <PaintRow key={index} paint={paint} index={index} open={openIndex === index} stroke={binding?.field === 'strokes'} imageUrl={paint.type === 'IMAGE' ? doc.images[paint.imageRef]?.url ?? null : null}
            binding={binding ?? null} onOpen={onOpen} onPaint={onPaint} onRemove={onRemove} committer={committer} grip={rows.length > 1 ? gripProps(row) : null} />
        );
      })}
    </div>
  );
}

type RowProps = {
  paint: Paint;
  index: number;
  /** A stroke's row: its fields and undo steps say "stroke". */
  stroke?: boolean;
  open: boolean;
  imageUrl: string | null;
  binding: PaintRowsProps['binding'];
  onOpen: (index: number, row: HTMLElement) => void;
  onPaint: (index: number, paint: Paint, label: string) => void;
  onRemove: (index: number) => void;
  committer: Committer;
  grip: ReturnType<ReturnType<typeof useRowReorder>['gripProps']> | null;
};

const PaintRow = memo(function PaintRow({paint, index, stroke = false, open, imageUrl, binding, onOpen, onPaint, onRemove, committer, grip}: RowProps) {
  const hidden = paint.visible === false;
  const bindable = !!binding && paint.type === 'SOLID';
  return (
    <div className={`dz-paint-row ${open ? 'is-open' : ''} ${hidden ? 'is-hidden' : ''}`.trim()} role="listitem" data-reorder-row="">
      {grip && <span className="dz-row-grip" aria-hidden="true" {...grip}><IconGrip size={12} /></span>}
      <div className="dz-paint-field">
        <PaintSwatch paint={paint} imageUrl={imageUrl} open={open} label="Open palette" onClick={row => onOpen(index, row)} />
        {bindable && paint.type === 'SOLID' && paint.boundVariables?.color ? (
          <PaintVariableChip ids={binding!.ids} field={binding!.field} index={index} />
        ) : paint.type === 'SOLID' ? (
          <HexField value={toHex(paint.color)} label="Color" onCommit={hex => {
            const parsed = parseHex(hex);
            if (parsed) onPaint(index, {...unbound(paint), color: parsed.color, opacity: parsed.alpha ?? paint.opacity}, 'Color');
          }} />
        ) : (
          <button type="button" className="dz-paint-kind" onClick={event => onOpen(index, event.currentTarget.closest('.dz-paint-row') as HTMLElement)}>{paintLabel(paint)}</button>
        )}
        {bindable && paint.type === 'SOLID' && !paint.boundVariables?.color && (
          <VariableBindButton paint={{target: binding!.field, index}} ids={binding!.ids} className="dz-paint-varbind" />
        )}
      </div>
      <NumberField aria-label={stroke ? 'Stroke opacity' : 'Fill opacity'} value={percent(paint.opacity)} min={0} max={100} precision={0} suffix="%" className="dz-paint-opacity"
        onScrubStart={() => committer.begin('Opacity')} onScrubEnd={cancelled => (cancelled ? committer.cancel() : committer.end())}
        onChange={value => onPaint(index, {...paint, opacity: value / 100}, 'Opacity')} />
      <IconButton label={hidden ? 'Show' : 'Hide'} className="dz-paint-eye" onClick={() => onPaint(index, {...paint, visible: hidden}, `${hidden ? 'Show' : 'Hide'} ${stroke ? 'stroke' : 'fill'}`)}>
        {hidden ? <IconEyeOff /> : <IconEye />}
      </IconButton>
      <IconButton label="Delete" onClick={() => onRemove(index)}><IconMinus /></IconButton>
    </div>
  );
});

/** The swatch of a paint: its colour (opaque left half when translucent), gradient or picture. */
export function PaintSwatch({paint, imageUrl, open, label, onClick, ref}: {paint: Paint; imageUrl?: string | null; open?: boolean; label: string; onClick: (row: HTMLElement) => void; ref?: Ref<HTMLButtonElement>}) {
  const translucent = paint.type === 'SOLID' && paint.opacity < 1;
  const style = {
    '--dz-swatch': paintPreview(paint, imageUrl),
    '--dz-swatch-solid': paint.type === 'SOLID' ? rgbaCss(paint.color, 1) : paintPreview(paint, imageUrl),
    '--dz-swatch-alpha': paint.type === 'SOLID' ? paint.opacity : 1,
  } as CSSProperties;
  return (
    <button ref={ref} type="button" aria-label={label} aria-expanded={open} className={`dz-paint-swatch ${translucent ? 'is-split' : ''} is-${paint.type === 'SOLID' ? 'solid' : paint.type === 'IMAGE' ? 'image' : 'gradient'}`}
      style={style} onClick={event => onClick(event.currentTarget.closest('[data-paint-anchor], .dz-paint-row, .dz-paint-style-row') as HTMLElement ?? event.currentTarget)}>
      <span className="dz-paint-swatch-fill" />
    </button>
  );
}

/** A hex typed in place: Enter or leaving commits, Escape reverts; ⌘Z before typing undoes the document's last change. */
export function HexField({value, label, onCommit, disabled}: {value: string; label: string; onCommit: (value: string) => void; disabled?: boolean}) {
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  // Undo or another panel changes the colour while the field is focused but untouched: it shows the new one.
  useEffect(() => {
    if (draft !== null && !dirty.current) setDraft(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className="dz-paint-hex" aria-label={label} value={draft ?? value} spellCheck={false} autoComplete="off" maxLength={9} disabled={disabled}
      onFocus={event => {
        dirty.current = false;
        setDraft(value);
        const input = event.currentTarget;
        requestAnimationFrame(() => {if (document.activeElement === input) input.select();});
      }}
      onChange={event => {
        dirty.current = true;
        setDraft(event.currentTarget.value);
      }}
      onBlur={event => {
        const text = event.currentTarget.value;
        dirty.current = false;
        setDraft(null);
        if (text.trim().replace(/^#/, '').toUpperCase() !== value) onCommit(text);
      }}
      onKeyDown={event => {
        if (!dirty.current && isUndoKey(event)) {
          handToDocument(event.nativeEvent);
          return;
        }
        if (event.key === 'Enter') event.currentTarget.blur();
        else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          dirty.current = false;
          setDraft(value);
          const input = event.currentTarget;
          requestAnimationFrame(() => input.blur());
        }
      }} />
  );
}

const sameState = (a: VariableBindingState | null, b: VariableBindingState | null) => deepEqual(a, b);

/** A bound colour: the shared variable chip (panels/variables) in place of the hex. */
function PaintVariableChip({ids, field, index}: {ids: readonly NodeId[]; field: PaintField; index: number}) {
  const services = useEditorServices();
  const target = useMemo((): VariableBindTarget => ({paint: field, index}), [field, index]);
  const state = useDesignStore(store => bindingState(store.doc, ids, target), sameState, {slice: 'doc'});
  return state ? <VariableChip services={services} ids={ids} target={target} state={state} /> : null;
}

export function RowNote({children}: {children: ReactNode}) {
  return <p className="dz-paint-note">{children}</p>;
}
