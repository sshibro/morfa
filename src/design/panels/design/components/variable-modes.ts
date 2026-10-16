import type {DesignDocument, NodeId} from '../../../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../../../shared/design/types';
import {modeForNode, setNodeVariableMode} from '../../../../../shared/design/variables';
import {chainEdits, runEdit} from '../../../engine/commands/components';
import type {DesignStore} from '../../../engine/store';
import type {SelectionInfo} from '../sections';
import {MIXED, type Mixed} from './model';

// The model and action of the "Variables" section (VariableModesSection.tsx): which mode of each
// variable collection the selected frames use, and picking one (setNodeVariableMode, one undo step).

/** The "Auto" choice: the frame inherits its parent's mode. */
export const AUTO = '__auto__';

export type ModeRow = {
  collectionId: string;
  name: string;
  modes: {modeId: string; name: string}[];
  /** The mode picked on the frames, AUTO when they inherit, MIXED when they differ. */
  value: string | Mixed;
  /** The mode an "Auto" frame gets now (from its parent). */
  inherited: string;
};

const frameIds = (doc: DesignDocument, ids: readonly NodeId[]) => ids.filter(id => {
  const node = doc.nodes[id];
  return !!node && (FRAME_LIKE_TYPES.includes(node.type) || node.type === 'SECTION');
});

export const hasModeChoice = (doc: DesignDocument) => Object.values(doc.variableCollections).some(collection => collection.modes.length > 1);

export const variableModesApply = (selection: SelectionInfo) =>
  hasModeChoice(selection.doc) && selection.nodes.some(node => FRAME_LIKE_TYPES.includes(node.type) || node.type === 'SECTION');

/** The rows of the section: one per collection with a choice of modes. */
export function modeRows(doc: DesignDocument, ids: readonly NodeId[]): ModeRow[] {
  const frames = frameIds(doc, ids);
  if (!frames.length) return [];
  const rows: ModeRow[] = [];
  for (const collection of Object.values(doc.variableCollections)) {
    if (collection.modes.length < 2) continue;
    let value: string | Mixed | undefined;
    for (const id of frames) {
      const own = doc.variableModes?.[id]?.[collection.id];
      const picked = own && collection.modes.some(mode => mode.modeId === own) ? own : AUTO;
      value = value === undefined ? picked : value === picked ? value : MIXED;
    }
    const parent = doc.nodes[frames[0]]?.parentId;
    const inheritedId = parent ? modeForNode(doc, parent, collection.id) : collection.defaultModeId;
    const inherited = collection.modes.find(mode => mode.modeId === inheritedId)?.name ?? collection.modes[0].name;
    rows.push({collectionId: collection.id, name: collection.name, modes: collection.modes.map(mode => ({modeId: mode.modeId, name: mode.name})), value: value ?? AUTO, inherited});
  }
  return rows;
}

export function setFramesMode(store: DesignStore, ids: readonly NodeId[], collectionId: string, modeId: string | null): void {
  const frames = frameIds(store.getState().doc, ids);
  runEdit(store, 'Variable mode', doc => chainEdits(doc, frames, (current, id) => setNodeVariableMode(current, id, collectionId, modeId)));
}
