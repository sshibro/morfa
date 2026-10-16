import {memo, useCallback, useSyncExternalStore} from 'react';
import type {EditorState} from '../../../engine/store';
import {editedVectorId, sessionOf, subscribeAnchors} from '../../../engine/vector-edit';
import {PanelSection} from '../../../ui/PanelSection';
import type {SectionProps} from '../sections';
import {sameSectionProps, usePanelEdit, usePanelState, usePanelStore} from '../shared/edit';
import {PanelNumber, Row} from '../shared/fields';
import {sameValue} from '../shared/mixed';
import {moveSelectedPoints, selectedPointsBox} from './points';

// "Point" / "Points" (order 19), shown while a path is edited and points are selected, as Figma's Design panel shows the
// selected points' X and Y: typing or scrubbing moves those points (points.ts). Nothing else renders it.

const editingOf = (state: EditorState) => editedVectorId(state);

export const PointSection = memo(function PointSection({ids}: SectionProps) {
  const store = usePanelStore();
  const edit = usePanelEdit();
  const editing = usePanelState(editingOf, Object.is, 'editing');
  const keys = useSyncExternalStore(useCallback(listener => subscribeAnchors(store, listener), [store]), () => sessionOf(store).selected);
  const id = editing && ids.length === 1 && ids[0] === editing ? editing : null;
  const box = usePanelState(useCallback((state: EditorState) => (id ? selectedPointsBox(state.doc, id, keys) : null), [id, keys]), sameValue);
  if (!id || !box) return null;
  const move = (axis: 'x' | 'y') => (change: (value: number) => number, source?: Parameters<typeof edit.run>[2]) =>
    edit.run(axis === 'x' ? 'Point X' : 'Point Y', tx => {
      const start = selectedPointsBox(tx.doc, id, keys);
      if (start) moveSelectedPoints(tx, id, keys, axis, change(start[axis]));
    }, source);
  return (
    <PanelSection title={box.count > 1 ? 'Points' : 'Point'} className="dz-pl-section">
      <Row>
        <PanelNumber label="X" aria-label="Point X" value={box.x} edit={edit} onChange={move('x')} />
        <PanelNumber label="Y" aria-label="Point Y" value={box.y} edit={edit} onChange={move('y')} />
      </Row>
    </PanelSection>
  );
}, sameSectionProps);
