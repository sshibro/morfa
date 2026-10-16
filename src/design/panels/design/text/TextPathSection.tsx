import {memo, useCallback} from 'react';
import type {NodeId, SceneNode} from '../../../../../shared/design/types';
import type {EditorState} from '../../../engine/store';
import {useDesignStore} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {Button, IconButton} from '../../../ui/Button';
import {IconSwap, IconTextPath} from '../../../ui/icons';
import {NumberField} from '../../../ui/NumberField';
import {PanelSection} from '../../../ui/PanelSection';
import {useCommitter} from '../paint/editing';
import type {SectionProps} from '../sections';

// "Text on path" in the design panel, for texts that follow a path (shared/design/text-path.ts): where the text
// starts along the path, the side it runs on, and "Detach from path", which turns it back into a plain text of
// automatic width where it stood. Alignment along the path and across it is "Text"'s own alignment.

type PathValues = {ids: NodeId[]; start: number | 'mixed'; side: 'LEFT' | 'RIGHT' | 'mixed'};

const samePath = (a: PathValues, b: PathValues) => a.start === b.start && a.side === b.side && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]);

function pathValues(state: EditorState, ids: readonly NodeId[]): PathValues {
  const nodes = ids.map(id => state.doc.nodes[id]).filter((node): node is SceneNode => !!node?.textPath);
  const starts = new Set(nodes.map(node => Math.round(node.textPath!.startOffset * 10000) / 100));
  const sides = new Set(nodes.map(node => node.textPath!.side));
  return {ids: nodes.map(node => node.id), start: starts.size === 1 ? [...starts][0] : 'mixed', side: sides.size === 1 ? [...sides][0] : 'mixed'};
}

export const TextPathSection = memo(function TextPathSection({ids}: SectionProps) {
  const selector = useCallback((state: EditorState) => pathValues(state, ids), [ids]);
  const values = useDesignStore(selector, samePath, {slice: 'doc'});
  const committer = useCommitter();
  const edit = (label: string, make: (node: SceneNode) => Partial<SceneNode> | null) => committer.set(label, tx => {
    for (const id of values.ids) {
      const node = tx.get(id);
      const patch = node?.textPath ? make(node) : null;
      if (patch) userUpdate(tx, id, patch);
    }
  });
  if (!values.ids.length) return null;
  return (
    <PanelSection title="Text on path" className="dz-text-path-section">
      <div className="dz-text-path-row">
        <NumberField label="Start" aria-label="Text start on the path" title="Where on the path the text starts: a share of its length" value={values.start} min={0} max={100}
          precision={1} suffix="%" step={1} scrubStep={0.5}
          onScrubStart={() => committer.begin('Text start')} onScrubEnd={cancelled => (cancelled ? committer.cancel() : committer.end())}
          onChange={value => edit('Text start', node => ({textPath: {...node.textPath!, startOffset: Math.max(0, Math.min(1, value / 100))}}))} />
        <IconButton label="Other side of the path" pressed={values.side === 'RIGHT'}
          onClick={() => edit('Text side', node => ({textPath: {...node.textPath!, side: node.textPath!.side === 'RIGHT' ? 'LEFT' : 'RIGHT'}}))}>
          <IconSwap />
        </IconButton>
      </div>
      <Button icon={<IconTextPath />} className="dz-text-path-detach"
        onClick={() => edit('Detach from path', node => ({textPath: undefined, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', text: {...node.text!, textAutoResize: 'WIDTH_AND_HEIGHT', textAlignVertical: 'TOP'}}))}>
        Detach from path
      </Button>
    </PanelSection>
  );
});
