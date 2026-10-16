import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent} from 'react';
import type {NodeId, SceneNode} from '../../../../shared/design/types';
import {TYPE_NAMES} from '../../../../shared/design/defaults';
import {isComponentLike, topLevelSelection} from '../../../../shared/design/tree';
import type {CommandContext} from '../../engine/commands/registry';
import type {DesignStore, EditorState} from '../../engine/store';
import {childSelection, parentSelection, toggleInSelection} from '../../engine/selection';
import {useDesignStore} from '../../engine/useDesignStore';
import {userUpdate} from '../../engine/user-edit';
import {useEditorServices} from '../../editor/services';
import {useContextMenu} from '../../ui/Menu';
import {TextInput} from '../../ui/TextInput';
import {isMacPlatform} from '../../ui/shortcuts';
import {IconChevronRight, IconEye, IconEyeOff, IconExclude, IconIntersect, IconLock, IconSubtract, IconUnion, IconUnlock, layerIcon, type IconComponent} from '../../ui/icons';
import {layerMenuItems, registerLeftPanelCommands, setLocked, setVisible} from './commands';
import {applyDrop, dropTarget, orderAfterDrop, panelOrder, type DropIndicator} from './layer-drop';
import {INDENT, ROW_HEIGHT, hasChildRows, rangeOfRows, type LayerRows} from './layer-rows';
import {panelCommandContext, selectFromPanel} from './panel-context';
import {layerTreeState} from './tree-state';
import {TOUCH_SELECT_TOOL} from '../../engine/touch/select-tool';
import {RenameLayersDialog} from './RenameLayersDialog';

// The layers tree: a virtualized list of the current page's layers, top-most first. Only the rows in
// view (plus a few above and below) exist in the DOM; each subscribes to its own node with an equality
// that ignores geometry, so dragging a layer on the canvas re-renders no row. The tree itself listens
// to the rows model (tree-state.ts: changes only when a visible children list changes), the selection
// and the hover. Events are delegated to the list, so rows carry data, not callbacks.

/** Rows rendered beyond the visible ones on each side. */
const OVERSCAN = 6;
/** Space above the first row and below the last. */
const PAD_TOP = 4;
const PAD_BOTTOM = 12;
/** Where depth 0 starts: the row's inset, then the caret column. */
const ROW_INSET = 8;
const CARET = 16;
const DRAG_THRESHOLD = 4;
const AUTOSCROLL_EDGE = 28;

const domId = (id: NodeId) => `dz-layer-${id}`;

// ── Flags of the rows in view ─────────────────────────────────────────────────────────────────────

const SELECTED = 1, IN_SELECTED = 2, IN_HIDDEN = 4, IN_LOCKED = 8;
const selectionSets = new WeakMap<readonly NodeId[], ReadonlySet<NodeId>>();
function selectionSet(selection: readonly NodeId[]): ReadonlySet<NodeId> {
  let set = selectionSets.get(selection);
  if (!set) selectionSets.set(selection, (set = new Set(selection)));
  return set;
}

/** One character per row from `from` to `to`: selected, inside a selected layer, inside a hidden or a locked one. */
function windowFlags(state: EditorState, rows: LayerRows, from: number, to: number): string {
  const selected = selectionSet(state.selection);
  const nodes = state.doc.nodes;
  let out = '';
  for (let i = Math.max(0, from); i < Math.min(rows.length, to); i++) {
    const id = rows.ids[i];
    let bits = selected.has(id) ? SELECTED : 0;
    for (let up: SceneNode | undefined = nodes[nodes[id]?.parentId ?? '']; up && up.type !== 'PAGE'; up = up.parentId ? nodes[up.parentId] : undefined) {
      if (selected.has(up.id)) bits |= IN_SELECTED;
      if (!up.visible) bits |= IN_HIDDEN;
      if (up.locked) bits |= IN_LOCKED;
    }
    out += String.fromCharCode(48 + bits);
  }
  return out;
}

// ── A row ──────────────────────────────────────────────────────────────────────────────────────

const hasImage = (node: SceneNode) => node.fills.some(fill => fill.type === 'IMAGE');

/** A row re-renders only when what it shows changes (not on moves and resizes). */
function sameRow(a: SceneNode | undefined, b: SceneNode | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.type === b.type && a.visible === b.visible && a.locked === b.locked && a.isMask === b.isMask
    && !!a.children?.length === !!b.children?.length && a.autoLayout?.layoutMode === b.autoLayout?.layoutMode
    && a.booleanOperation === b.booleanOperation && a.mainId === b.mainId && (a.fills === b.fills || hasImage(a) === hasImage(b));
}

const BOOLEAN_ICONS: Record<string, IconComponent> = {UNION: IconUnion, SUBTRACT: IconSubtract, INTERSECT: IconIntersect, EXCLUDE: IconExclude};

function iconOf(node: SceneNode): IconComponent {
  if (node.type === 'BOOLEAN_OPERATION' && !node.isMask) return BOOLEAN_ICONS[node.booleanOperation ?? 'UNION'] ?? IconUnion;
  return layerIcon(node.type, {mask: node.isMask, image: hasImage(node), layout: node.autoLayout?.layoutMode});
}

type RowProps = {
  store: DesignStore;
  id: NodeId;
  depth: number;
  bits: number;
  runTop: boolean;
  runBottom: boolean;
  expanded: boolean;
  hovered: boolean;
  /** The last selected row (keyboard focus ring). */
  active: boolean;
  dragged: boolean;
  renaming: boolean;
  onRenameDone: (id: NodeId, value: string | null, move?: 1 | -1) => void;
};

const LayerRow = memo(function LayerRow({store, id, depth, bits, runTop, runBottom, expanded, hovered, active, dragged, renaming, onRenameDone}: RowProps) {
  const node = useDesignStore(state => state.doc.nodes[id], sameRow, {store, slice: 'doc'});
  if (!node) return <div className="dz-layer-row" style={{'--dz-depth': depth} as CSSProperties} />;
  const Icon = iconOf(node);
  const selected = !!(bits & SELECTED);
  const inSelected = !selected && !!(bits & IN_SELECTED);
  const parentHidden = !!(bits & IN_HIDDEN);
  const parentLocked = !!(bits & IN_LOCKED);
  const container = hasChildRows(node);
  const top = depth === 0 && (node.type === 'FRAME' || node.type === 'SECTION' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET');
  const classes = [
    'dz-layer-row',
    selected && 'is-selected',
    inSelected && 'is-in-selected',
    (selected || inSelected) && runTop && 'is-run-top',
    (selected || inSelected) && runBottom && 'is-run-bottom',
    hovered && 'is-hovered',
    active && 'is-active',
    isComponentLike(node) && 'is-component',
    (!node.visible || parentHidden) && 'is-hidden',
    !node.visible && 'is-own-hidden',
    node.locked && 'is-locked',
    top && 'is-top',
    dragged && 'is-dragged',
    renaming && 'is-renaming',
  ].filter(Boolean).join(' ');
  return (
    <div role="treeitem" id={domId(id)} aria-level={depth + 1} aria-selected={selected} aria-expanded={container ? expanded : undefined}
      aria-label={rowLabel(node)} className={classes} style={{'--dz-depth': depth} as CSSProperties} data-row-id={id}>
      <span className={`dz-layer-caret ${expanded ? 'is-open' : ''}`} data-caret={container ? '' : undefined} aria-hidden="true">
        {container && <IconChevronRight size={12} />}
      </span>
      <span className="dz-layer-icon" aria-hidden="true"><Icon /></span>
      {renaming
        ? <RenameField initial={node.name} onDone={(value, move) => onRenameDone(id, value, move)} />
        : <span className="dz-layer-name" data-name="">{node.name}</span>}
      {!renaming && (hovered || node.locked || !node.visible) && (
        <span className="dz-layer-actions">
          <button type="button" tabIndex={-1} data-action="lock" className={`dz-layer-action ${node.locked ? 'is-on' : ''} ${parentLocked && !node.locked ? 'is-inherited' : ''}`.trim()}
            aria-label={node.locked ? 'Unlock' : 'Lock'} aria-pressed={node.locked}>
            {node.locked ? <IconLock /> : <IconUnlock />}
          </button>
          <button type="button" tabIndex={-1} data-action="visible" className={`dz-layer-action ${!node.visible ? 'is-on' : ''}`.trim()}
            aria-label={node.visible ? 'Hide' : 'Show'} aria-pressed={!node.visible}>
            {node.visible ? <IconEye /> : <IconEyeOff />}
          </button>
        </span>
      )}
    </div>
  );
});

/** What a screen reader says for a row: the layer's name and type, then its hidden and locked states — never
 *  the labels of the lock and eye buttons that show on hover. */
function rowLabel(node: SceneNode): string {
  const parts = [node.name, TYPE_NAMES[node.type].toLowerCase()];
  if (!node.visible) parts.push('layer hidden');
  if (node.locked) parts.push('layer locked');
  return parts.join(', ');
}

/** The inline name field: Enter or leaving it renames, Escape keeps the old name, Tab goes on to the next layer. */
function RenameField({initial, onDone}: {initial: string; onDone: (value: string | null, move?: 1 | -1) => void}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (next: string | null, move?: 1 | -1) => {
    if (done.current) return;
    done.current = true;
    onDone(next, move);
  };
  useLayoutEffect(() => {
    input.current?.focus({preventScroll: true});
    input.current?.select();
  }, []);
  return (
    <TextInput className="dz-layer-rename" value={value} onChange={setValue} inputRef={input} aria-label="Layer name"
      onCommit={next => finish(next)} onCancel={() => finish(null)} onBlur={event => finish(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        finish(event.currentTarget.value, event.shiftKey ? -1 : 1);
      }} />
  );
}

// ── The tree ───────────────────────────────────────────────────────────────────────────────────

export type LayersTreeProps = {
  /** Commands of the row menu run with this context (the canvas controller's); a panel one otherwise. */
  commandContext?: () => CommandContext;
};

type Pending = {id: NodeId; x: number; y: number; pointerId: number; deferSelect: boolean};
type Drag = {
  block: NodeId[];
  x: number;
  y: number;
  target: {parentId: NodeId; index: number} | null;
  frame: number;
  /** A collapsed container held under "into" opens after a moment, as in Figma. */
  hold: {id: NodeId; timer: ReturnType<typeof setTimeout>} | null;
};

/** How long a collapsed container waits under a dragged layer before it opens. */
const SPRING_OPEN_MS = 600;

export const LayersTree = memo(function LayersTree({commandContext}: LayersTreeProps) {
  const services = useEditorServices();
  const {store} = services;
  const tree = layerTreeState(store);
  useSyncExternalStore(tree.subscribe, tree.getVersion, tree.getVersion);
  const rows = tree.rows();
  const count = rows.length;
  const pageId = rows.pageId;

  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({start: 0, end: 0});
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [dragged, setDragged] = useState<ReadonlySet<NodeId> | null>(null);
  const [, setTick] = useState(0);
  const anchor = useRef<NodeId | null>(null);
  const fromPanel = useRef(false);
  const pendingScroll = useRef<{id: NodeId; centre: boolean} | null>(null);
  const pending = useRef<Pending | null>(null);
  const drag = useRef<Drag | null>(null);
  const menu = useContextMenu();

  useEffect(() => registerLeftPanelCommands(), []);

  // ── Virtualization ──
  // The scroll offset and the height are cached (read in the scroll event and the resize observer),
  // so a re-render never forces a layout to learn them.
  const metrics = useRef({top: 0, height: 0});
  const updateRange = useCallback(() => {
    const total = tree.rows().length;
    const {top: scrolled, height} = metrics.current;
    const top = Math.max(0, scrolled - PAD_TOP);
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(total, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    setRange(current => (current.start === start && current.end === end ? current : {start, end}));
  }, [tree]);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    metrics.current = {top: element.scrollTop, height: element.clientHeight};
    updateRange();
  }, [updateRange]);
  useLayoutEffect(updateRange, [updateRange, count, rows.version]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    metrics.current = {top: element.scrollTop, height: element.clientHeight};
    updateRange();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      metrics.current = {...metrics.current, height: entries[0]?.contentRect.height ?? element.clientHeight};
      updateRange();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateRange, count === 0]);
  // A page keeps no scroll of its own: a new page starts at the top.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    metrics.current = {...metrics.current, top: 0};
    anchor.current = null;
    setRenaming(null);
  }, [pageId]);

  const start = Math.min(range.start, count);
  const end = Math.min(Math.max(range.end, start), count);
  const base = Math.max(0, start - 1);
  const flags = useDesignStore(state => windowFlags(state, rows, base, end + 1), Object.is, {store, slice: ['doc', 'selection']});
  const hoverId = useDesignStore(state => state.hoverId, Object.is, {store, slice: 'hover'});
  const primary = useDesignStore(state => state.selection.at(-1) ?? null, Object.is, {store, slice: 'selection'});
  const bitsAt = (index: number) => {
    const at = index - base;
    return at >= 0 && at < flags.length ? flags.charCodeAt(at) - 48 : 0;
  };

  // ── Selection from the canvas: expand to it and scroll it into view ──
  useEffect(() => store.select(state => state.selection, selection => {
    const last = selection.at(-1);
    const own = fromPanel.current;
    if (!last) return;
    if (!own) tree.reveal(selection.length > 200 ? selection.slice(-200) : selection);
    pendingScroll.current = {id: last, centre: !own};
    setTick(tick => tick + 1);
  }, {slice: 'selection'}), [store, tree]);

  const scrollToRow = useCallback((id: NodeId, centre: boolean) => {
    const element = scroller.current;
    const current = tree.rows();
    const row = current.rowOf(id);
    if (!element || row < 0) return;
    const {top: scrolled, height: view} = metrics.current;
    const top = PAD_TOP + row * ROW_HEIGHT;
    if (top >= scrolled && top + ROW_HEIGHT <= scrolled + view) return;
    const far = top < scrolled - view || top > scrolled + 2 * view;
    let next = centre && far ? top - view / 2 + ROW_HEIGHT / 2 : top < scrolled ? top - PAD_TOP : top + ROW_HEIGHT - view + PAD_BOTTOM;
    next = Math.round(Math.max(0, Math.min(PAD_TOP + current.length * ROW_HEIGHT + PAD_BOTTOM - view, next)));
    element.scrollTop = next;
    // Render the new window now rather than a frame later from the scroll event.
    metrics.current = {top: next, height: view};
    updateRange();
  }, [tree, updateRange]);
  useLayoutEffect(() => {
    const request = pendingScroll.current;
    if (!request) return;
    pendingScroll.current = null;
    scrollToRow(request.id, request.centre);
  });

  // ── Selecting ──
  /** Runs a change of the selection made here: the listener below then neither expands nor centres. */
  const ownSelection = useCallback((change: () => void) => {
    fromPanel.current = true;
    try {
      change();
    } finally {
      fromPanel.current = false;
    }
  }, []);
  const select = useCallback((ids: readonly NodeId[], focus?: NodeId) => ownSelection(() => selectFromPanel(services, ids, focus)), [services, ownSelection]);

  const rowAtClientY = (clientY: number): number => {
    const element = scroller.current;
    if (!element) return -1;
    const y = clientY - element.getBoundingClientRect().top + metrics.current.top - PAD_TOP;
    return Math.floor(y / ROW_HEIGHT);
  };

  // ── Rename ──
  const [batch, setBatch] = useState<readonly NodeId[] | null>(null);
  useEffect(() => tree.onBatchRenameRequest(ids => setBatch(ids)), [tree]);
  useEffect(() => tree.onRenameRequest(id => {
    if (tree.rows().rowOf(id) < 0) tree.reveal([id]);
    pendingScroll.current = {id, centre: false};
    setRenaming(id);
  }), [tree]);
  const renameDone = useCallback((id: NodeId, value: string | null, move?: 1 | -1) => {
    const node = store.getState().doc.nodes[id];
    const name = value?.trim();
    if (node && name && name !== node.name) store.transact('Rename', tx => userUpdate(tx, id, {name}));
    const current = tree.rows();
    const next = move ? current.ids[current.rowOf(id) + move] : undefined;
    if (next) {
      select([next], next);
      pendingScroll.current = {id: next, centre: false};
      setRenaming(next);
    } else {
      setRenaming(null);
      scroller.current?.focus({preventScroll: true});
    }
  }, [store, tree, select]);

  // ── Dragging rows ──
  const updateDrop = useCallback(() => {
    const state = drag.current;
    const element = scroller.current;
    if (!state || !element) return;
    const current = tree.rows();
    const {doc} = store.getState();
    const rect = element.getBoundingClientRect();
    const y = state.y - rect.top + element.scrollTop - PAD_TOP;
    const row = Math.max(-1, Math.min(current.length, Math.floor(y / ROW_HEIGHT)));
    const fraction = y / ROW_HEIGHT - Math.floor(y / ROW_HEIGHT);
    const level = (state.x - rect.left - ROW_INSET - CARET) / INDENT;
    const target = dropTarget(doc, current, {row, fraction, level}, state.block, current.pageId);
    const moves = target && orderAfterDrop(doc, state.block, target.parentId, target.index);
    state.target = target && moves ? {parentId: target.parentId, index: target.index} : null;
    const next = target && moves ? target.indicator : null;
    setIndicator(previous => (previous?.kind === next?.kind && previous?.row === next?.row && (previous?.kind !== 'line' || next?.kind !== 'line' || previous.depth === next.depth) ? previous : next));
    // The canvas outlines where the layers would go.
    store.setHover(state.target && state.target.parentId !== current.pageId ? state.target.parentId : null);
    const holding = next?.kind === 'into' && !current.expanded.has(current.ids[next.row]) ? current.ids[next.row] : null;
    if (state.hold?.id !== holding) {
      if (state.hold) clearTimeout(state.hold.timer);
      state.hold = holding ? {id: holding, timer: setTimeout(() => {
        if (drag.current !== state) return;
        state.hold = null;
        tree.setExpanded(holding, true);
        updateDropRef.current();
      }, SPRING_OPEN_MS)} : null;
    }
  }, [store, tree]);
  const updateDropRef = useRef(updateDrop);
  updateDropRef.current = updateDrop;

  const autoscroll = useCallback(() => {
    const state = drag.current;
    const element = scroller.current;
    if (!state || !element) return;
    const rect = element.getBoundingClientRect();
    let delta = 0;
    if (state.y < rect.top + AUTOSCROLL_EDGE) delta = -Math.ceil((rect.top + AUTOSCROLL_EDGE - state.y) / 3);
    else if (state.y > rect.bottom - AUTOSCROLL_EDGE) delta = Math.ceil((state.y - rect.bottom + AUTOSCROLL_EDGE) / 3);
    if (delta) {
      element.scrollTop += Math.max(-24, Math.min(24, delta));
      updateDrop();
    }
    state.frame = requestAnimationFrame(autoscroll);
  }, [updateDrop]);

  const finishPointer = useRef<(event: PointerEvent, cancel?: boolean) => void>(() => {});
  finishPointer.current = (event, cancel = false) => {
    const state = drag.current;
    const press = pending.current;
    pending.current = null;
    drag.current = null;
    if (state) {
      cancelAnimationFrame(state.frame);
      if (state.hold) clearTimeout(state.hold.timer);
      store.setHover(null);
      setIndicator(null);
      setDragged(null);
      scroller.current?.closest('.dz')?.classList.remove('dz-dragging-layers');
      if (!cancel && state.target) {
        const {parentId, index} = state.target;
        const block = state.block;
        ownSelection(() => store.transact('Move layers', tx => void applyDrop(tx, block, parentId, index), {select: block}));
        if (parentId !== pageId) tree.setExpanded(parentId, true);
      }
      return;
    }
    if (!cancel && press?.deferSelect && event.type === 'pointerup') select([press.id], press.id);
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const press = pending.current;
      if (!press || event.pointerId !== press.pointerId) return;
      const state = drag.current;
      if (state) {
        state.x = event.clientX;
        state.y = event.clientY;
        updateDrop();
        return;
      }
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
      const {doc, selection} = store.getState();
      const ids = selection.includes(press.id) ? topLevelSelection(doc, selection) : [press.id];
      if (!ids.length || ids.some(id => !doc.nodes[id] || doc.nodes[id].mainId !== undefined || doc.nodes[id].type === 'PAGE')) {
        pending.current = null;
        return;
      }
      if (!selection.includes(press.id)) select([press.id], press.id);
      const block = panelOrder(doc, tree.rows(), ids);
      drag.current = {block, x: event.clientX, y: event.clientY, target: null, frame: 0, hold: null};
      // Keep the pointer while it leaves the panel (or the window) during the drag.
      try {
        scroller.current?.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone.
      }
      setDragged(new Set(block));
      scroller.current?.closest('.dz')?.classList.add('dz-dragging-layers');
      store.setHover(null);
      updateDrop();
      drag.current.frame = requestAnimationFrame(autoscroll);
    };
    const up = (event: PointerEvent) => {
      if (pending.current && event.pointerId === pending.current.pointerId) finishPointer.current(event);
    };
    const cancel = (event: PointerEvent) => {
      if (pending.current && event.pointerId === pending.current.pointerId) finishPointer.current(event, true);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        finishPointer.current(new PointerEvent('pointercancel'), true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (drag.current) cancelAnimationFrame(drag.current.frame);
    };
  }, [store, tree, select, updateDrop, autoscroll]);


  // ── Pointer on the rows ──
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest('input')) return;
    const rowElement = target.closest<HTMLElement>('[data-row-id]');
    if (!rowElement) {
      if (target.closest('.dz-layers-content') || target === scroller.current) select([]);
      return;
    }
    const id = rowElement.dataset.rowId!;
    if (target.closest('[data-caret]')) {
      event.preventDefault();
      tree.setExpanded(id, !tree.rows().expanded.has(id), event.altKey);
      return;
    }
    if (target.closest('[data-action]')) {
      event.preventDefault();
      return;
    }
    const mac = isMacPlatform();
    // A finger has no ⌘: with the phone's "Select" on (engine/touch/select-tool.ts) a tap on a row adds or removes it.
    const mod = (mac ? event.metaKey : event.ctrlKey) || (event.pointerType === 'touch' && store.getState().tool === TOUCH_SELECT_TOOL);
    const {selection} = store.getState();
    let deferSelect = false;
    if (mod) {
      select(toggleInSelection(selection, id), id);
      anchor.current = id;
    } else if (event.shiftKey) {
      const current = tree.rows();
      const from = current.rowOf(anchor.current ?? selection.at(-1) ?? id);
      select(from >= 0 ? rangeOfRows(current, from, current.rowOf(id)).filter(each => each !== id).concat(id) : [id], id);
    } else if (selection.includes(id)) {
      deferSelect = selection.length > 1;
      anchor.current = id;
      if (!deferSelect) select([id], id);
    } else {
      select([id], id);
      anchor.current = id;
    }
    pending.current = {id, x: event.clientX, y: event.clientY, pointerId: event.pointerId, deferSelect};
  };

  const click = (event: ReactMouseEvent<HTMLDivElement>) => {
    const action = (event.target as Element).closest<HTMLElement>('[data-action]');
    const rowElement = action?.closest<HTMLElement>('[data-row-id]');
    if (!action || !rowElement) return;
    const id = rowElement.dataset.rowId!;
    const node = store.getState().doc.nodes[id];
    if (!node) return;
    if (action.dataset.action === 'visible') setVisible(store, [id], !node.visible);
    else setLocked(store, [id], !node.locked);
  };

  const doubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('[data-caret], [data-action], input')) return;
    const rowElement = target.closest<HTMLElement>('[data-row-id]');
    if (rowElement && target.closest('[data-name], .dz-layer-icon')) setRenaming(rowElement.dataset.rowId!);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current || event.pointerType === 'touch') return;
    const row = rowAtClientY(event.clientY);
    const id = row >= 0 && row < tree.rows().length ? tree.rows().ids[row] : null;
    if (store.getState().hoverId !== id) store.setHover(id);
  };
  const pointerLeave = () => {
    if (!drag.current && store.getState().hoverId) store.setHover(null);
  };

  const contextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rowElement = (event.target as Element).closest<HTMLElement>('[data-row-id]');
    if (!rowElement) return;
    const id = rowElement.dataset.rowId!;
    // On a caret on a touch screen (a long press, where ⌥-click is not): open or close everything inside, as ⌥-click does (lane PH).
    if ((event.target as Element).closest('[data-caret]') && window.matchMedia('(pointer: coarse)').matches) {
      menu.open(event, [
        {id: 'layers.expand-deep', label: 'Expand all nested', onSelect: () => tree.setExpanded(id, true, true)},
        {id: 'layers.collapse-deep', label: 'Collapse all nested', onSelect: () => tree.setExpanded(id, false, true)},
      ]);
      return;
    }
    if (!store.getState().selection.includes(id)) select([id], id);
    const ctx = commandContext?.() ?? panelCommandContext(services, scroller.current);
    menu.open(event, layerMenuItems(ctx, {onRename: target => {
      // Several selected: "Rename layers" for all of them, as Figma's row menu does.
      const selection = store.getState().selection;
      if (selection.length > 1 && selection.includes(target)) setBatch(selection);
      else setRenaming(target);
    }}));
  };

  // ── Keyboard ──
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== scroller.current || event.metaKey || event.ctrlKey || event.altKey) return;
    const current = tree.rows();
    const {doc, selection} = store.getState();
    const last = selection.at(-1);
    const at = last ? current.rowOf(last) : -1;
    const go = (row: number) => {
      const id = current.ids[Math.max(0, Math.min(current.length - 1, row))];
      if (!id) return;
      if (event.shiftKey) {
        const from = current.rowOf(anchor.current ?? last ?? id);
        select(from >= 0 ? rangeOfRows(current, from, current.rowOf(id)).filter(each => each !== id).concat(id) : [id], id);
      } else {
        select([id], id);
        anchor.current = id;
      }
    };
    let handled = true;
    switch (event.key) {
      case 'ArrowDown': go(at < 0 ? 0 : at + 1); break;
      case 'ArrowUp': go(at < 0 ? current.length - 1 : at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(current.length - 1); break;
      case 'ArrowLeft': {
        if (!last) break;
        if (current.expanded.has(last) && hasChildRows(doc.nodes[last])) tree.setExpanded(last, false);
        else {
          const parent = doc.nodes[last]?.parentId;
          if (parent && parent !== current.pageId) select([parent], parent);
        }
        break;
      }
      case 'ArrowRight': {
        if (!last || !hasChildRows(doc.nodes[last])) break;
        if (!current.expanded.has(last)) tree.setExpanded(last, true);
        else if (at >= 0) go(at + 1);
        break;
      }
      case 'Enter': {
        if (!selection.length) break;
        const next = event.shiftKey ? parentSelection(doc, selection, current.pageId) : childSelection(doc, selection);
        if (next && next.selection.length) {
          if (!event.shiftKey) tree.reveal(next.selection);
          ownSelection(() => {
            store.setSelection(next.selection);
            store.setContext(next.context);
          });
        }
        break;
      }
      case 'F2':
        if (last) setRenaming(last);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  // ── Render ──
  const items = [];
  for (let i = start; i < end; i++) {
    const id = rows.ids[i];
    const bits = bitsAt(i);
    const lit = (bits & (SELECTED | IN_SELECTED)) !== 0;
    items.push(
      <LayerRow key={id} store={store} id={id} depth={rows.depths[i]} bits={bits}
        runTop={lit && !(bitsAt(i - 1) & (SELECTED | IN_SELECTED))} runBottom={lit && !(bitsAt(i + 1) & (SELECTED | IN_SELECTED))}
        expanded={rows.expanded.has(id)} hovered={hoverId === id && !dragged} active={primary === id} dragged={!!dragged?.has(id)} renaming={renaming === id}
        onRenameDone={renameDone} />,
    );
  }
  const activeDescendant = primary && rows.rowOf(primary) >= start && rows.rowOf(primary) < end ? domId(primary) : undefined;

  return (
    <div ref={scroller} className={`dz-layers-scroll ${dragged ? 'is-dragging' : ''}`.trim()} role="tree" aria-label="Layers" aria-multiselectable="true" tabIndex={0}
      aria-activedescendant={activeDescendant} onScroll={onScroll} onKeyDown={keyDown}>
      {count === 0 ? (
        <p className="dz-layers-empty">{store.readOnly ? 'Nothing on this page yet.' : 'Nothing on this page yet. Draw a frame (F) or a shape — layers will appear here.'}</p>
      ) : (
        <div className="dz-layers-content" style={{height: PAD_TOP + count * ROW_HEIGHT + PAD_BOTTOM}}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerLeave={pointerLeave} onClick={click} onDoubleClick={doubleClick} onContextMenu={contextMenu}>
          <div className="dz-layers-window" style={{transform: `translateY(${PAD_TOP + start * ROW_HEIGHT}px)`}}>{items}</div>
          {indicator && <DropMark indicator={indicator} />}
        </div>
      )}
      {menu.element}
      {batch && <RenameLayersDialog store={store} ids={batch} onClose={() => setBatch(null)} />}
    </div>
  );
});

function DropMark({indicator}: {indicator: DropIndicator}) {
  if (indicator.kind === 'into') return <div className="dz-layer-drop-into" style={{transform: `translateY(${PAD_TOP + indicator.row * ROW_HEIGHT}px)`}} aria-hidden="true" />;
  const left = ROW_INSET + CARET + indicator.depth * INDENT;
  return <div className="dz-layer-drop-line" style={{left, transform: `translateY(${PAD_TOP + indicator.row * ROW_HEIGHT - 1}px)`}} aria-hidden="true" />;
}
