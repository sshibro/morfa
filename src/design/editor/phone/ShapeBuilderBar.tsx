import {useEffect, useState} from 'react';
import {Button} from '../../ui/Button';
import {SegmentedControl} from '../../ui/Tabs';
import type {DesignStore} from '../../engine/store';
import {setTouchTakesAway} from '../../engine/touch/shape-builder-mode';
import {useDesignStore} from '../../engine/useDesignStore';
import {SHAPE_BUILDER_TOOL} from '../../engine/commands/shape-builder';

type Mode = 'merge' | 'subtract';
const MODES = [{value: 'merge', label: 'Merge'}, {value: 'subtract', label: 'Subtract'}] as const;

/** "Shape builder" by touch (a phone or a tablet): a finger has no ⌥ and no Escape, so while the builder is in hand
 *  this bar says what a tap or a drag across regions does — merge them or take them away — and "Done" puts the
 *  builder down. */
export function ShapeBuilderBar({store}: {store: DesignStore}) {
  const active = useDesignStore(state => state.tool === SHAPE_BUILDER_TOOL, Object.is, {store, slice: 'tool'});
  const [mode, setMode] = useState<Mode>('merge');
  useEffect(() => {
    setTouchTakesAway(store, active && mode === 'subtract');
  }, [store, active, mode]);
  useEffect(() => {
    if (!active) setMode('merge');
  }, [active]);
  if (!active) return null;
  return (
    <div className="dz-touch-builder" role="toolbar" aria-label="Shape builder">
      <SegmentedControl options={MODES} value={mode} onChange={setMode} size={32} aria-label="What a tap does" />
      <Button size={32} variant="primary" onClick={() => store.setTool('move')}>Done</Button>
    </div>
  );
}
