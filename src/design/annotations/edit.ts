import type {Annotation, AnnotationPropertyType, NodeId} from '../../../shared/design/types';
import {newAnnotationId} from '../../../shared/design/annotations';
import type {DesignStore} from '../engine/store';
import {userUpdate} from '../engine/user-edit';

// Writing dev annotations into their layer (docs/design-tool.md §Dev annotations and measurements). Each save is one undo
// step and replaces the layer's list; co-editing merges the list note by note (shared/design/merge.ts), and a new note's
// id is random, so two people writing notes on one layer at once keep both.

/** What the note editor holds. */
export type NoteDraft = {label: string; categoryId: string | undefined; properties: AnnotationPropertyType[]};

/** Writes the note into its layer (one undo step); an empty note is removed or never made. Returns the note's id, or null
 *  when nothing is stored. */
export function saveNote(store: DesignStore, nodeId: NodeId, annotationId: string | null, draft: NoteDraft): string | null {
  const node = store.getState().doc.nodes[nodeId];
  if (!node) return null;
  const list = node.annotations ?? [];
  const label = draft.label.trim() ? draft.label.replace(/\s+$/, '') : '';
  const empty = !label && !draft.properties.length;
  const existing = annotationId ? list.find(note => note.id === annotationId) : undefined;
  if (empty && !existing) return null;
  let next: Annotation[];
  let id: string | null = null;
  if (empty) next = list.filter(note => note.id !== annotationId);
  else {
    const note: Annotation = {id: existing?.id ?? newAnnotationId(list), label};
    if (draft.categoryId) note.categoryId = draft.categoryId;
    if (draft.properties.length) note.properties = draft.properties.map(type => ({type}));
    id = note.id;
    if (existing && JSON.stringify(existing) === JSON.stringify(note)) return id;
    next = existing ? list.map(entry => (entry.id === existing.id ? note : entry)) : [...list, note];
  }
  store.transact(existing && empty ? 'Delete annotation' : 'Annotation', tx => userUpdate(tx, nodeId, {annotations: next.length ? next : undefined}), {annotation: true});
  return id;
}

/** Removes one note from its layer (one undo step). */
export function removeNote(store: DesignStore, nodeId: NodeId, annotationId: string): void {
  const node = store.getState().doc.nodes[nodeId];
  const list = node?.annotations ?? [];
  if (!list.some(note => note.id === annotationId)) return;
  const next = list.filter(note => note.id !== annotationId);
  store.transact('Delete annotation', tx => userUpdate(tx, nodeId, {annotations: next.length ? next : undefined}), {annotation: true});
}
