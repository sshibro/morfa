import {memo, useCallback, useContext} from 'react';
import {EditorServicesContext} from '../../editor/services';
import type {DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {editedVectorId, exitVectorEdit, sessionOf} from '../../engine/vector-edit/session';
import {Button, IconButton} from '../../ui/Button';
import {IconBend, IconMove, IconPen} from '../../ui/icons';
import {isMacPlatform} from '../../ui/shortcuts';
import '../../styles/vector.css';

// The bar of the vector editor: while a vector is being edited it stands where the toolbar was
// (the toolbar hides, as Figma swaps them) with the editor's tools — "Select" (V), "Pen" (P),
// "Bend" (held ⌘ does the same for a moment) — and "Done" (Enter, Esc). It renders nothing
// outside the editor, so it can sit in the canvas overlay for good. It re-renders only when the
// editing state or the tool changes, never during a drag.

export type VectorEditBarProps = {
  /** Defaults to the open file's store (useEditorServices). */
  store?: DesignStore;
};

const BAR_TOOLS = [
  {id: 'vector-edit', label: 'Select', shortcut: 'KeyV', Icon: IconMove},
  {id: 'pen', label: 'Pen', shortcut: 'KeyP', Icon: IconPen},
  {id: 'vector-bend', label: 'Bend', shortcut: undefined, Icon: IconBend},
] as const;

export const VectorEditBar = memo(function VectorEditBar({store: given}: VectorEditBarProps) {
  const services = useContext(EditorServicesContext);
  const store = given ?? services?.store;
  if (!store) throw new Error('VectorEditBar needs a store (prop or editor services)');
  const editing = useDesignStore(editedVectorId, Object.is, {slice: 'editing', store});
  const tool = useDesignStore(state => state.tool, Object.is, {slice: 'tool', store});
  const choose = useCallback((id: string) => {
    if (id !== 'pen') sessionOf(store).drawing = null;
    store.setTool(id);
  }, [store]);
  const done = useCallback(() => exitVectorEdit(store), [store]);
  if (!editing) return null;
  const mac = isMacPlatform();
  return (
    <div className="dz-vector-bar" role="toolbar" aria-label="Path editing">
      {BAR_TOOLS.map(({id, label, shortcut, Icon}) => (
        <IconButton key={id} size={32} tone="toolbar" label={id === 'vector-bend' ? `${label} — or hold ${mac ? '⌘' : 'Ctrl'}` : label}
          shortcut={shortcut} tooltip={{placement: 'top'}} pressed={tool === id} onClick={() => choose(id)}>
          <Icon />
        </IconButton>
      ))}
      <Button size={32} variant="secondary" className="dz-vector-done" onClick={done}>Done</Button>
    </div>
  );
});
