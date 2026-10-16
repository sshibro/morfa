import {memo} from 'react';
import type {DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {nodesBounds} from '../../engine/viewport';
import {stripFrames, viewportBetweenBars, type StripFrame} from './frame-strip-model';

const sameFrames = (a: readonly StripFrame[], b: readonly StripFrame[]) => a.length === b.length && a.every((frame, i) => frame.id === b[i].id && frame.name === b[i].name);

/** The page's top-level frames in a row over the bottom bar (Figma's app: the preview slider); a tap shows the frame whole
 *  between the bars and selects it. */
export const FrameStrip = memo(function FrameStrip({store}: {store: DesignStore}) {
  const frames = useDesignStore(state => stripFrames(state.doc, state.pageId), sameFrames, {store, slice: ['doc', 'page']});
  const selected = useDesignStore(state => (state.selection.length === 1 ? state.selection[0] : null), Object.is, {store, slice: 'selection'});
  const show = (event: React.MouseEvent<HTMLButtonElement>, id: string) => {
    const area = event.currentTarget.closest('.dz-canvas-area');
    const bounds = nodesBounds(store.getState().doc, [id]);
    if (!area || !bounds) return;
    const box = area.getBoundingClientRect();
    const top = area.querySelector('.dz-phone-top')?.getBoundingClientRect().bottom ?? box.top;
    const bottom = event.currentTarget.closest('.dz-phone-strip')?.getBoundingClientRect().top ?? box.bottom;
    store.setSelection([id]);
    store.setViewport(viewportBetweenBars({width: box.width, height: box.height}, bounds, top - box.top, box.bottom - bottom));
  };
  return (
    <nav className="dz-phone-strip" aria-label="Frames on this page">
      {frames.length ? frames.map(frame => (
        <button key={frame.id} type="button" className="dz-phone-strip-item" aria-current={frame.id === selected ? 'true' : undefined} onClick={event => show(event, frame.id)}>
          {frame.name}
        </button>
      )) : <span className="dz-phone-strip-empty">No frames on this page</span>}
    </nav>
  );
});
