import '../../styles/annotations.css';
import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent} from 'react';
import type {Annotation, DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import {worldBox} from '../../../../shared/design/geometry';
import {
  annotationCategory, annotationColor, annotationPropertiesFor, annotationPropertyLabel, annotationValue, ANNOTATION_CATEGORIES, ANNOTATION_COLORS, pageAnnotations,
} from '../../../../shared/design/annotations';
import {measurementText, pageMeasurements} from '../../../../shared/design/measurements';
import {drawLabel} from '../../engine/overlay';
import {currentViewport, type DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {removeNote, saveNote, type NoteDraft as Draft} from '../edit';
import {Button, IconButton} from '../../ui/Button';
import {IconClose, IconPlus, IconTrash} from '../../ui/icons';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {ANNOTATION_TOOL, annotationsState, MEASURE_TOOL, type AnnotationsUI} from '../state';
import {MEASURE_COLOR} from '../tools';

// Dev annotations and measurements over the canvas (docs/design-tool.md §Dev annotations and measurements). Pinned
// measurements, the outlines of annotated layers and the leader lines are drawn on a canvas in screen px; each annotated
// layer's notes are a column of DOM cards beside its top-right corner, the note being written among them. Positions are
// written straight to the elements on every viewport or document change (no React render for a pan), and the list of
// notes is read again only when no drag is under way. Nothing here animates with the canvas; the editor card fades in
// from its layer's side when opened with the pointer (never from the keyboard).

/** Screen px between a layer's right edge and its notes. */
const GAP = 24;

type NoteGroup = {node: SceneNode; notes: Annotation[]};

export function useAnnotationsUI(store: DesignStore): AnnotationsUI {
  const state = annotationsState(store);
  return useSyncExternalStore(state.subscribe, state.get);
}

const sameGroups = (a: readonly NoteGroup[], b: readonly NoteGroup[]) => a.length === b.length && a.every((group, i) => group.node === b[i].node && group.notes === b[i].notes);

function groupsOf(doc: DesignDocument, pageId: NodeId): NoteGroup[] {
  const groups: NoteGroup[] = [];
  for (const {node} of pageAnnotations(doc, pageId)) {
    if (groups[groups.length - 1]?.node === node) continue;
    groups.push({node, notes: node.annotations ?? []});
  }
  return groups;
}

export function AnnotationsLayer({store, readOnly}: {store: DesignStore; readOnly: boolean}) {
  const ui = useAnnotationsUI(store);
  const tool = useDesignStore(state => state.tool, Object.is, {store, slice: 'tool'});
  const shown = ui.visible || tool === ANNOTATION_TOOL || tool === MEASURE_TOOL;
  const [groups, setGroups] = useState<NoteGroup[]>(() => groupsOf(store.getState().doc, store.getState().pageId));
  const stacks = useRef(new Map<NodeId, HTMLDivElement>());
  const canvas = useRef<HTMLCanvasElement>(null);
  const hovered = useRef<NodeId | null>(null);
  const editing = ui.editing;
  const editingNode = editing ? store.getState().doc.nodes[editing.nodeId] : undefined;
  // A new note on a layer without notes yet: a column of its own, for the editor (placed like any other).
  const shownGroups = useMemo(() => {
    if (!editing || !editingNode || groups.some(group => group.node.id === editing.nodeId)) return groups;
    return [...groups, {node: editingNode, notes: []}];
  }, [groups, editing, editingNode]);
  const latest = useRef({groups: shownGroups, ui, shown});
  latest.current = {groups: shownGroups, ui, shown};

  // The notes of the page: read again after each change once no gesture is live (a drag keeps the last list and only
  // moves the cards).
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const state = store.getState();
      if (state.live.size) return;
      const next = groupsOf(state.doc, state.pageId);
      setGroups(current => (sameGroups(current, next) ? current : next));
    };
    const off = store.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(read);
    }, {slice: ['doc', 'page', 'live']});
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [store]);

  const place = useCallback(() => {
    const state = store.getState();
    const viewport = currentViewport(state);
    const {groups: list, ui: now, shown: visible} = latest.current;
    const host = canvas.current;
    if (!host) return;
    const width = host.clientWidth, height = host.clientHeight, dpr = window.devicePixelRatio || 1;
    if (host.width !== Math.round(width * dpr) || host.height !== Math.round(height * dpr)) {
      host.width = Math.round(width * dpr);
      host.height = Math.round(height * dpr);
    }
    const ctx = host.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, host.width, host.height);
    if (!visible) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = (x: number) => (x - viewport.x) * viewport.zoom, sy = (y: number) => (y - viewport.y) * viewport.zoom;
    const crisp = (v: number) => Math.round(v) + 0.5;
    // Annotated layers: their outline and a leader to their notes, in the first note's colour.
    for (const group of list) {
      const node = state.doc.nodes[group.node.id];
      const element = stacks.current.get(group.node.id);
      if (!node || !element) continue;
      const box = worldBox(state.doc, node.id);
      const left = sx(box.x), top = sy(box.y), right = sx(box.x + box.width), bottom = sy(box.y + box.height);
      element.style.translate = `${Math.round(right + GAP)}px ${Math.round(top)}px`;
      const color = annotationColor(group.notes[0] ?? {});
      ctx.strokeStyle = color;
      ctx.globalAlpha = hovered.current === node.id || now.editing?.nodeId === node.id ? 1 : 0.55;
      ctx.lineWidth = hovered.current === node.id ? 2 : 1;
      ctx.strokeRect(crisp(left), crisp(top), Math.round(right - left), Math.round(bottom - top));
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(right, crisp(top + 12));
      ctx.lineTo(right + GAP, crisp(top + 12));
      ctx.stroke();
    }
    // Pinned measurements.
    for (const {measurement, geometry} of pageMeasurements(state.doc, state.pageId)) {
      const strong = measurement.id === now.selectedMeasurement || measurement.id === now.hoverMeasurement;
      const a = {x: sx(geometry.from.x), y: sy(geometry.from.y)}, b = {x: sx(geometry.to.x), y: sy(geometry.to.y)};
      ctx.strokeStyle = MEASURE_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const extension of geometry.extensions) {
        ctx.beginPath();
        ctx.moveTo(crisp(sx(extension.from.x)), crisp(sy(extension.from.y)));
        ctx.lineTo(crisp(sx(extension.to.x)), crisp(sy(extension.to.y)));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = strong ? 2 : 1;
      ctx.beginPath();
      if (geometry.axis === 'x') {
        const y = crisp(a.y);
        ctx.moveTo(a.x, y);
        ctx.lineTo(b.x, y);
        for (const x of [a.x, b.x]) {
          ctx.moveTo(crisp(x), y - 4);
          ctx.lineTo(crisp(x), y + 4);
        }
      } else {
        const x = crisp(a.x);
        ctx.moveTo(x, a.y);
        ctx.lineTo(x, b.y);
        for (const y of [a.y, b.y]) {
          ctx.moveTo(x - 4, crisp(y));
          ctx.lineTo(x + 4, crisp(y));
        }
      }
      ctx.stroke();
      const text = measurementText(measurement, geometry.value);
      const centre = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
      if (geometry.axis === 'x' && Math.abs(b.x - a.x) < 40) centre.y += 14;
      if (geometry.axis === 'y' && Math.abs(b.y - a.y) < 26) centre.x += 24;
      drawLabel(ctx, centre, text, {background: MEASURE_COLOR, anchor: 'center'});
    }
  }, [store]);

  useLayoutEffect(() => {
    place();
  });
  useEffect(() => {
    let frame = 0;
    const request = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const offStore = store.subscribe(request, {slice: ['viewport', 'doc', 'page', 'live']});
    const offUI = annotationsState(store).subscribe(request);
    const observer = new ResizeObserver(request);
    if (canvas.current) observer.observe(canvas.current);
    return () => {
      offStore();
      offUI();
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [store, place]);

  const hover = useCallback((id: NodeId | null) => {
    hovered.current = id;
    place();
  }, [place]);

  return (
    <div className="dz-annotations-layer">
      <canvas ref={canvas} className="dz-annotations-canvas" aria-hidden="true" />
      {shown && shownGroups.map(group => (
        <div key={group.node.id} className="dz-annotation-stack" ref={element => {
          if (element) stacks.current.set(group.node.id, element);
          else stacks.current.delete(group.node.id);
        }} onPointerEnter={() => hover(group.node.id)} onPointerLeave={() => hover(null)}>
          {group.notes.map(note => (editing?.nodeId === group.node.id && editing.annotationId === note.id
            ? <NoteEditor key={note.id} store={store} nodeId={group.node.id} annotation={note} />
            : <NoteCard key={note.id} store={store} node={group.node} note={note} editable={!readOnly}
                onEdit={() => annotationsState(store).set({editing: {nodeId: group.node.id, annotationId: note.id}})} />))}
          {editing?.nodeId === group.node.id && editing.annotationId === null && <NoteEditor store={store} nodeId={group.node.id} annotation={null} />}
        </div>
      ))}
    </div>
  );
}

// ── A note ───────────────────────────────────────────────────────────────────────────────────────

const NoteCard = memo(function NoteCard({store, node, note, editable, onEdit}: {store: DesignStore; node: SceneNode; note: Annotation; editable: boolean; onEdit: () => void}) {
  const category = annotationCategory(note.categoryId);
  const doc = store.getState().doc;
  return (
    <div className={`dz-annotation ${editable ? 'is-editable' : ''}`.trim()} style={{'--dz-note': annotationColor(note)} as CSSProperties}
      role={editable ? 'button' : undefined} tabIndex={editable ? 0 : undefined} aria-label={editable ? `Edit annotation "${note.label || node.name}"` : undefined}
      onClick={editable ? onEdit : undefined}
      onKeyDown={editable ? (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit();
        }
      } : undefined}>
      {category && <span className="dz-annotation-chip">{category.label}</span>}
      {note.label && <p className="dz-annotation-text">{note.label}</p>}
      {!!note.properties?.length && (
        <dl className="dz-annotation-props">
          {note.properties.map(property => (
            <div key={property.type} className="dz-annotation-prop">
              <dt>{annotationPropertyLabel(property.type)}</dt>
              <dd>{annotationValue(doc, node, property.type)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
});

// ── Writing a note ───────────────────────────────────────────────────────────────────────────────

function NoteEditor({store, nodeId, annotation}: {store: DesignStore; nodeId: NodeId; annotation: Annotation | null}) {
  const node = useDesignStore(state => state.doc.nodes[nodeId], Object.is, {store, slice: 'doc'});
  const [draft, setDraft] = useState<Draft>(() => ({label: annotation?.label ?? '', categoryId: annotation?.categoryId, properties: annotation?.properties?.map(p => p.type) ?? []}));
  const card = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const closed = useRef(false);

  const annotationId = annotation?.id ?? null;
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    saveNote(store, nodeId, annotationId, latest.current);
    const ui = annotationsState(store);
    const editing = ui.get().editing;
    if (editing?.nodeId === nodeId && editing.annotationId === annotationId) ui.set({editing: null});
  }, [store, nodeId, annotationId]);

  // Leaving it (a press outside the card and its menus, Escape, Enter, another note opened) keeps what was written.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    text.current?.focus({preventScroll: true});
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || card.current?.contains(target) || target.closest('[data-dz-menu]')) return;
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      alive.current = false;
      document.removeEventListener('pointerdown', outside, true);
      // Unmounted for good (not React's development remount): save.
      setTimeout(() => {
        if (!alive.current) close();
      }, 0);
    };
  }, [close]);

  // The text area grows with what is written.
  useLayoutEffect(() => {
    const area = text.current;
    if (!area) return;
    area.style.height = '0px';
    area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
  }, [draft.label]);

  const addable = useCallback((): MenuItem[] => {
    if (!node) return [];
    const options = annotationPropertiesFor(node).filter(entry => !latest.current.properties.includes(entry.type));
    return options.length
      ? options.map(entry => ({id: entry.type, label: entry.label, description: annotationValue(store.getState().doc, node, entry.type), onSelect: () => setDraft(current => ({...current, properties: [...current.properties, entry.type]}))}))
      : [{type: 'label', label: 'All properties are already added'}];
  }, [node, store]);
  const menu = useMenuTrigger({items: addable, label: 'Layer property', placement: 'bottom-start', minWidth: 220});

  if (!node) return null;
  const color = draft.categoryId ? ANNOTATION_COLORS[annotationCategory(draft.categoryId)?.color ?? 'blue'] : undefined;
  return (
    <div ref={card} className="dz-annotation is-editor" style={(color ? {'--dz-note': color} : {}) as CSSProperties} role="dialog" aria-label={annotation ? 'Annotation' : 'New annotation'}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}>
      <div className="dz-annotation-categories" role="radiogroup" aria-label="Category">
        {ANNOTATION_CATEGORIES.map(category => (
          <button key={category.id} type="button" role="radio" aria-checked={draft.categoryId === category.id} className="dz-annotation-category"
            style={{'--dz-note': ANNOTATION_COLORS[category.color]} as CSSProperties}
            onClick={() => setDraft(current => ({...current, categoryId: current.categoryId === category.id ? undefined : category.id}))}>
            <span className="dz-annotation-dot" aria-hidden="true" />{category.label}
          </button>
        ))}
      </div>
      <textarea ref={text} className="dz-annotation-input" rows={2} placeholder="Note for developers" aria-label="Annotation text" value={draft.label}
        maxLength={10_000}
        onChange={event => setDraft(current => ({...current, label: event.target.value}))}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            close();
          }
        }} />
      {!!draft.properties.length && (
        <dl className="dz-annotation-props">
          {draft.properties.map(type => (
            <div key={type} className="dz-annotation-prop">
              <dt>{annotationPropertyLabel(type)}</dt>
              <dd>{annotationValue(store.getState().doc, node, type)}</dd>
              <IconButton label={`Remove "${annotationPropertyLabel(type)}"`} size={24} className="dz-annotation-prop-remove"
                onClick={() => setDraft(current => ({...current, properties: current.properties.filter(entry => entry !== type)}))}>
                <IconClose />
              </IconButton>
            </div>
          ))}
        </dl>
      )}
      <div className="dz-annotation-actions">
        <Button icon={<IconPlus />} {...menu.triggerProps}>Property</Button>
        {menu.element}
        <span className="dz-annotation-spacer" />
        {annotation && (
          <IconButton label="Delete annotation" onClick={() => {
            closed.current = true;
            removeNote(store, nodeId, annotation.id);
            annotationsState(store).set({editing: null});
          }}><IconTrash /></IconButton>
        )}
        <Button variant="primary" onClick={() => close()}>Done</Button>
      </div>
    </div>
  );
}
