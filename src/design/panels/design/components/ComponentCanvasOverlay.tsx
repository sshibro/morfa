import {useLayoutEffect, useRef} from 'react';
import {apply, worldMatrix} from '../../../../../shared/design/geometry';
import {pageIdOf} from '../../../../../shared/design/tree';
import {useEditorServices} from '../../../editor/services';
import {addVariantToSet, setOfSelection} from '../../../engine/commands/components';
import {currentViewport} from '../../../engine/store';
import {useDesignStore} from '../../../engine/useDesignStore';
import {pageToScreen} from '../../../engine/viewport';
import {useTooltip} from '../../../ui/Tooltip';
import {IconPlus} from '../../../ui/icons';
import '../../../styles/panel-components.css';

// Over the canvas (EditorLayout's `overlay` slot): the round "+" on a selected variant set — or the
// set of a selected variant — that adds a variant below the others, as in Figma. It sits in the set's
// bottom margin, centred; pans and zooms move it by its `translate` outside React (not `transform`, which
// the 0.96 press `scale` would multiply, pulling the button toward the canvas's corner), and it hides while a
// drag runs. The set's dashed purple border is its own stroke (variants.ts), drawn by the scene.

const SIZE = 18;
/** Hidden when the set is shorter than this on screen (the button would cover the variants). */
const MIN_SCREEN_HEIGHT = 56;

export function ComponentCanvasOverlay() {
  const services = useEditorServices();
  const store = services.store;
  // Not in "Code" (Dev Mode reads the design, nothing there edits it).
  const setId = useDesignStore(state => (state.live.size || state.editing || state.ui.devMode ? null : setOfSelection(state.doc, state.selection)), Object.is, {slice: ['selection', 'doc', 'live', 'editing', 'ui'], store});
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip({label: 'Add variant'});

  useLayoutEffect(() => {
    const element = button.current;
    if (!setId || !element) return;
    const place = () => {
      const state = store.getState();
      const node = state.doc.nodes[setId];
      if (!node || pageIdOf(state.doc, setId) !== state.pageId) {
        element.style.visibility = 'hidden';
        return;
      }
      const viewport = currentViewport(state);
      const m = worldMatrix(state.doc, setId);
      // The middle of the set's bottom margin (variants keep a 20 px gap to the border), and never
      // closer to the border than the resize handle drawn on it.
      const bottom = pageToScreen(viewport, apply(m, {x: node.width / 2, y: node.height}));
      const top = pageToScreen(viewport, apply(m, {x: node.width / 2, y: 0}));
      const lift = Math.max(10 * viewport.zoom, SIZE / 2 + 5);
      element.style.visibility = Math.abs(bottom.y - top.y) < MIN_SCREEN_HEIGHT ? 'hidden' : 'visible';
      element.style.translate = `${Math.round(bottom.x - SIZE / 2)}px ${Math.round(bottom.y - lift - SIZE / 2)}px`;
    };
    place();
    return store.subscribe(place, {slice: ['viewport', 'doc', 'page']});
  }, [setId, store]);

  if (!setId) return null;
  return (
    <button ref={button} type="button" className="dz-cmp-canvas-add" aria-label="Add variant" {...tooltip}
      onPointerDown={event => {
        tooltip.onPointerDown?.(event);
        event.stopPropagation();
      }}
      onClick={() => {
        const {selection} = store.getState();
        addVariantToSet(store, setId, selection[0] !== setId ? selection[0] : undefined);
      }}>
      <IconPlus size={12} />
    </button>
  );
}
