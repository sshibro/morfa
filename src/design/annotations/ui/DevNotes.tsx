import '../../styles/annotations.css';
import {memo, useMemo, type CSSProperties} from 'react';
import type {Annotation, DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import {annotationCategory, annotationColor, annotationPropertyLabel, annotationValue, pageAnnotations} from '../../../../shared/design/annotations';
import {measurementText, pageMeasurements, sideAxis} from '../../../../shared/design/measurements';
import type {DesignStore} from '../../engine/store';
import {IconButton} from '../../ui/Button';
import {IconClose, IconMeasure, IconPlus} from '../../ui/icons';
import {PanelSection} from '../../ui/PanelSection';
import {annotationsState, ANNOTATION_TOOL} from '../state';
import {setMeasurements} from '../tools';
import {useAnnotationsUI} from './AnnotationsLayer';

// "Code" (dev mode), for developers: the notes on the selection (or every note of the page with nothing selected) and the
// measurements that touch it, each one a click away from its layer on the canvas. An editor edits and removes them here
// too; a developer with view access reads them. Nothing shows while there are none (the code comes first).

export type DevNotesProps = {
  store: DesignStore;
  doc: DesignDocument;
  pageId: NodeId;
  /** The selection (top-level ids); empty: the whole page. */
  ids: readonly NodeId[];
  canEdit: boolean;
  /** Selects and shows layers on the canvas. */
  reveal: (ids: readonly NodeId[]) => void;
};

export const DevNotes = memo(function DevNotes({store, doc, pageId, ids, canEdit, reveal}: DevNotesProps) {
  const ui = useAnnotationsUI(store);
  const notes = useMemo(() => {
    if (!ids.length) return pageAnnotations(doc, pageId);
    // The selected layers' own notes and their descendants', read from their subtrees (not the whole page: the tab
    // re-reads them on every change to the file).
    const out: {node: SceneNode; annotation: Annotation}[] = [];
    const stack = [...ids].reverse();
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node) continue;
      for (const annotation of node.annotations ?? []) out.push({node, annotation});
      const children = node.children ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return out;
  }, [doc, pageId, ids]);
  const measurements = useMemo(() => {
    const all = pageMeasurements(doc, pageId);
    return ids.length ? all.filter(({measurement}) => ids.includes(measurement.start.nodeId) || ids.includes(measurement.end.nodeId)) : all;
  }, [doc, pageId, ids]);
  const single = ids.length === 1 ? ids[0] : null;

  const addNote = () => {
    if (!single) return;
    store.setSelection([single]);
    store.setTool(ANNOTATION_TOOL);
    annotationsState(store).set({editing: {nodeId: single, annotationId: null}, visible: true});
  };
  const editNote = (nodeId: NodeId, annotationId: string) => {
    store.setSelection([nodeId]);
    reveal([nodeId]);
    annotationsState(store).set({editing: {nodeId, annotationId}, visible: true});
  };

  return (
    <>
      {notes.length > 0 && (
        <PanelSection title="Annotations" className="dz-devnotes"
          actions={canEdit && single ? <IconButton label="Add annotation" shortcut="KeyY" onClick={addNote}><IconPlus /></IconButton> : undefined}>
          <ul className="dz-devnotes-list">
            {notes.map(({node, annotation}) => {
              const category = annotationCategory(annotation.categoryId);
              return (
                <li key={node.id + '/' + annotation.id} className="dz-devnote" style={{'--dz-note': annotationColor(annotation)} as CSSProperties}>
                  <button type="button" className="dz-devnote-main" onClick={() => (canEdit ? editNote(node.id, annotation.id) : reveal([node.id]))}
                    aria-label={`${canEdit ? 'Edit' : 'Show'} annotation of layer "${node.name}"`}>
                    <span className="dz-devnote-head">
                      <span className="dz-annotation-dot" aria-hidden="true" />
                      <span className="dz-devnote-layer">{node.name}</span>
                      {category && <span className="dz-devnote-category">{category.label}</span>}
                    </span>
                    {annotation.label && <span className="dz-devnote-text">{annotation.label}</span>}
                    {annotation.properties?.map(property => (
                      <span key={property.type} className="dz-devnote-prop">
                        <span>{annotationPropertyLabel(property.type)}</span>
                        <span className="dz-devnote-value">{annotationValue(doc, node, property.type)}</span>
                      </span>
                    ))}
                  </button>
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}
      {measurements.length > 0 && (
        <PanelSection title="Measurements" className="dz-devnotes">
          <ul className="dz-devnotes-list">
            {measurements.map(({measurement, geometry}) => {
              const start = doc.nodes[measurement.start.nodeId], end = doc.nodes[measurement.end.nodeId];
              const own = measurement.start.nodeId === measurement.end.nodeId;
              const what = own ? `${sideAxis(measurement.start.side) === 'x' ? 'Width' : 'Height'} "${start?.name}"` : `"${start?.name}" — "${end?.name}"`;
              return (
                <li key={measurement.id} className={`dz-devnote is-measure ${ui.selectedMeasurement === measurement.id ? 'is-selected' : ''}`.trim()}>
                  <button type="button" className="dz-devnote-main" onClick={() => {
                    annotationsState(store).set({selectedMeasurement: measurement.id, visible: true});
                    reveal(own ? [measurement.start.nodeId] : [measurement.start.nodeId, measurement.end.nodeId]);
                  }}>
                    <span className="dz-devnote-head">
                      <IconMeasure size={14} aria-hidden="true" />
                      <span className="dz-devnote-layer">{what}</span>
                      <span className="dz-devnote-value">{measurementText(measurement, geometry.value)}</span>
                    </span>
                  </button>
                  {canEdit && (
                    <IconButton label="Delete measurement" className="dz-devnote-remove" onClick={() => {
                      setMeasurements(store, 'Delete measurement', list => list.filter(m => m.id !== measurement.id));
                      annotationsState(store).set({selectedMeasurement: null});
                    }}><IconClose /></IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}
    </>
  );
});
