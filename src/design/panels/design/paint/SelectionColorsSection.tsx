import {memo, useCallback, useEffect, useRef, useState} from 'react';
import type {DesignDocument, NodeId, Paint, RGB, SceneNode} from '../../../../../shared/design/types';
import {solid} from '../../../../../shared/design/defaults';
import type {DesignStore} from '../../../engine/store';
import {useDesignStore, useStoreApi} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {Button, IconButton} from '../../../ui/Button';
import {IconTarget} from '../../../ui/icons';
import {besidePanel} from '../../../ui/ColorPicker';
import {NumberField} from '../../../ui/NumberField';
import {PanelSection} from '../../../ui/PanelSection';
import type {Rect} from '../../../ui/position';
import type {SectionProps} from '../sections';
import {colorKey, parseHex, percent, toHex} from './color';
import {useCommitter, type Change, type Recipe} from './editing';
import {PaintPicker} from './PaintPicker';
import {HexField, PaintSwatch} from './PaintRows';
import {sameItems} from './PaintSection';
import {collectSelectionColors, nodesUsingColor, replaceColorUpdates, sameSelectionColors, type ColorUse} from './selection-colors';

// "Selection colors" (90): every solid colour in the selected layers and inside them (fills, strokes,
// coloured text ranges, shadows); changing one changes it everywhere in the selection. Shown, as in
// Figma, when more than one layer or a container is selected. The list is computed when no drag is
// running, so a gesture elsewhere never walks the selection on every frame; after an edit it is kept
// when the nodes that changed kept their colours and children (a nudge of 5 000 layers checks the ten
// frames it moved), and each node's colours are cached by identity when it does walk.

const SHOWN = 8;

/** The selection's colours on `doc`, listed again only when the document changed them. */
function useSelectionColors(store: DesignStore, doc: DesignDocument, ids: readonly NodeId[]): ColorUse[] {
  const listing = useRef<{doc: DesignDocument; colors: ColorUse[]} | null>(null);
  // Nodes changed since the listed document, each as the listing saw it (the first patch's inverse names it; a later
  // patch of the same id keeps that earliest value), or null when that is not known. The patches' inverses, not the
  // listed document, hold the earlier values: the store may write its table in place.
  const changed = useRef<Map<NodeId, SceneNode | undefined> | null>(new Map());
  useEffect(() => {
    const off = store.onPatch(event => {
      const map = changed.current;
      if (!map) return;
      for (const id of Object.keys(event.patch.nodes ?? {})) if (!map.has(id)) map.set(id, event.inverse.nodes?.[id] ?? undefined);
    });
    // A change between the first listing and this subscription went unseen.
    if (listing.current?.doc !== store.getState().doc) changed.current = null;
    return off;
  }, [store]);
  const last = listing.current;
  if (last?.doc === doc) return last.colors;
  const seen = changed.current;
  const colors = last && seen && sameSelectionColors(id => seen.get(id), doc, seen.keys()) ? last.colors : collectSelectionColors(doc, ids);
  listing.current = {doc, colors};
  changed.current = new Map();
  return colors;
}

function SelectionColorsBody({ids}: SectionProps) {
  const store = useStoreApi();
  // The document as it stands between gestures.
  const settled = useDesignStore(state => (state.live.size ? null : state.doc), Object.is, {slice: ['doc', 'live']});
  const last = useRef(settled ?? store.getState().doc);
  if (settled) last.current = settled;
  const colors = useSelectionColors(store, last.current, ids);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<{key: string; anchor: Rect; row: Element} | null>(null);
  // One callback for every row: a nudge re-checks the colours and, when they are the same, no row re-renders.
  const toggle = useCallback((key: string, row: HTMLElement) => setOpen(current => (current?.key === key ? null : {key, anchor: besidePanel(row), row})), []);
  if (!colors.length) return null;
  const shown = all ? colors : colors.slice(0, SHOWN);
  const openUse = open ? colors.find(use => use.key === open.key) : undefined;
  return (
    <PanelSection title="Selection colors">
      <div className="dz-paint-list" role="list" aria-label="Selection colors">
        {/* Rows are keyed by place, not colour: a colour changed from its own row (an arrow step on the opacity, a hex)
            keeps its place in the list, so the row and the field's focus stay for the next step. */}
        {shown.map((use, index) => (
          <SelectionColorRow key={index} use={use} ids={ids} open={open?.key === use.key} onOpen={toggle} />
        ))}
      </div>
      {colors.length > SHOWN && (
        <Button variant="ghost" size={24} className="dz-paint-more" onClick={() => setAll(value => !value)}>
          {all ? 'Show less' : `Show all (${colors.length})`}
        </Button>
      )}
      {open && openUse && <SelectionColorPicker use={openUse} ids={ids} anchor={open.anchor} trigger={open.row} onClose={() => setOpen(null)} onKey={key => setOpen(current => (current ? {...current, key} : current))} />}
    </PanelSection>
  );
}

/** Keyed by the selection: a new selection closes the picker this section had open. */
export const SelectionColorsSection = memo(function SelectionColorsSection({ids, nodes}: SectionProps) {
  return <SelectionColorsBody key={ids.join(',')} ids={ids} nodes={nodes} />;
}, (a, b) => sameItems(a.ids, b.ids));

/** One colour of the selection: swatch, hex and opacity, each editable. */
const SelectionColorRow = memo(function SelectionColorRow({use, ids, open, onOpen}: {use: ColorUse; ids: readonly NodeId[]; open: boolean; onOpen: (key: string, row: HTMLElement) => void}) {
  const store = useStoreApi();
  const replace = (color: RGB, opacity: number) => store.transact('Selection color', replaceRecipe(store.getState().doc, ids, use.key, color, opacity));
  const paint = solid(use.color, use.opacity);
  return (
    <div className={`dz-paint-row is-selection-color ${open ? 'is-open' : ''}`} role="listitem">
      <div className="dz-paint-field">
        <PaintSwatch paint={paint} open={open} label="Open palette" onClick={row => onOpen(use.key, row)} />
        <HexField value={toHex(use.color)} label="Color" onCommit={text => {
          const parsed = parseHex(text);
          if (parsed) replace(parsed.color, parsed.alpha ?? use.opacity);
        }} />
      </div>
      <NumberField aria-label="Opacity" value={percent(use.opacity)} min={0} max={100} precision={0} suffix="%" className="dz-paint-opacity"
        onChange={value => replace(use.color, value / 100)} />
      <IconButton label="Select layers with this color" className="dz-selection-target"
        onClick={() => store.setSelection(nodesUsingColor(store.getState().doc, ids, use.key))}><IconTarget /></IconButton>
    </div>
  );
});

/** Rewrites colour `key` in the nodes that use it (found once) with `color` at `opacity`. */
function replaceRecipe(doc: Parameters<typeof nodesUsingColor>[0], ids: readonly NodeId[], key: string, color: RGB, opacity: number): Recipe {
  const among = nodesUsingColor(doc, ids, key);
  return tx => {
    for (const [id, patch] of replaceColorUpdates(tx.doc, ids, key, color, opacity, among)) userUpdate(tx, id, patch);
  };
}

function SelectionColorPicker({use, ids, anchor, trigger, onClose, onKey}: {use: ColorUse; ids: readonly NodeId[]; anchor: Rect; trigger: Element; onClose: () => void; onKey: (key: string) => void}) {
  const store = useStoreApi();
  const committer = useCommitter();
  // The colour as it was when this change began: a drag re-runs from there on every frame.
  const from = useRef<{key: string; among: NodeId[]} | null>(null);
  const [paint, setPaint] = useState<Paint>(() => solid(use.color, use.opacity));
  const write = (next: Paint): Recipe => {
    if (next.type !== 'SOLID') return () => {};
    const base = from.current ?? {key: use.key, among: nodesUsingColor(store.getState().doc, ids, use.key)};
    if (committer.active) from.current = base;
    return tx => {
      for (const [id, patch] of replaceColorUpdates(tx.doc, ids, base.key, next.color, next.opacity, base.among)) userUpdate(tx, id, patch);
    };
  };
  const wrapped = {
    ...committer,
    get active() {
      return committer.active;
    },
    set(label: string, change: Change) {
      committer.set(label, change);
      if (!committer.active) settle();
    },
    end() {
      committer.end();
      settle();
    },
  };
  const latest = useRef(paint);
  const settle = () => {
    from.current = null;
    const next = latest.current;
    if (next.type === 'SOLID') onKey(colorKey(next.color, next.opacity));
  };
  return (
    <PaintPicker anchor={anchor} trigger={trigger} onClose={onClose} paint={paint} label="Selection color" committer={wrapped} kinds="solid"
      write={next => {
        latest.current = next;
        setPaint(next);
        return write(next);
      }} />
  );
}
