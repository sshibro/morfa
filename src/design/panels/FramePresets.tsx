import {memo, useCallback, useContext} from 'react';
import {rectContains, worldBox} from '../../../shared/design/geometry';
import {EditorServicesContext} from '../editor/services';
import {canvasSizeOf} from '../engine/rulers';
import {currentViewport, type DesignStore} from '../engine/store';
import {viewportCenter, visiblePageRect} from '../engine/viewport';
import {PanelSection} from '../ui/PanelSection';
import {FRAME_PRESET_GROUPS, insertPresetFrame, type FramePreset} from './frame-presets';
import '../styles/drawing.css';

export {framePresetsVisible} from './frame-presets';

// The right panel while "Frame" (F) is the tool: device and format sizes by group, as in Figma. A row
// inserts a frame of that size (frame-presets.ts) and brings it into view. Static data and one click
// handler: nothing here follows the canvas, so panning or drawing never re-renders it.

export type FramePresetsProps = {
  /** The editor's store; by default the open file's (EditorServices). */
  store?: DesignStore;
};

const formatSize = (preset: FramePreset) => `${preset.width}\u00a0×\u00a0${preset.height}`;

export const FramePresets = memo(function FramePresets({store: own}: FramePresetsProps) {
  const services = useContext(EditorServicesContext);
  const store = own ?? services?.store ?? null;
  const insert = useCallback((preset: FramePreset) => {
    if (!store) return;
    const size = canvasSizeOf(store) ?? {width: globalThis.innerWidth - 480 || 960, height: globalThis.innerHeight || 720};
    const viewport = currentViewport(store.getState());
    const id = insertPresetFrame(store, preset, viewportCenter(viewport, size));
    const doc = store.getState().doc;
    if (!rectContains(visiblePageRect(viewport, size), worldBox(doc, id))) services?.revealNodes([id]);
  }, [store, services]);
  if (!store) return null;
  return (
    <div className="dz-frame-presets">
      {FRAME_PRESET_GROUPS.map((group, index) => (
        <PanelSection key={group.id} title={group.label} collapsible first={index === 0}>
          <ul className="dz-preset-list" aria-label={group.label}>
            {group.presets.map(preset => (
              <li key={preset.id}>
                <button type="button" className="dz-preset-row" onClick={() => insert(preset)} aria-label={`${preset.name}, ${preset.width} by ${preset.height}`}>
                  <span className="dz-preset-name">{preset.name}</span>
                  <span className="dz-preset-size">{formatSize(preset)}</span>
                </button>
              </li>
            ))}
          </ul>
        </PanelSection>
      ))}
    </div>
  );
});
