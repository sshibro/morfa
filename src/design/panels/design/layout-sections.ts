import {FRAME_LIKE_TYPES} from '../../../../shared/design/types';
import type {DesignSection} from './sections';
import {PositionSection} from './layout/PositionSection';
import {SizeSection} from './layout/SizeSection';
import {PointSection} from './layout/PointSection';
import {LayoutGridSection} from './layout/LayoutGridSection';
import {LayerSection} from './layout/LayerSection';
import {ExportSection} from './layout/ExportSection';
import '../../styles/panel-layout.css';

// The "Design" panel sections owned by the layout feature (see sections.ts for the order numbers): "Point" 19 (while a
// path is edited), "Position" 20 with the alignment row, "Layout" 25 with auto layout in it, "Appearance" 50 (Figma UI3's
// Position, Layout and Appearance), "Layout grid" 105 (after the effects, as in Figma's panel), "Export" 110. The
// selection header is SelectionHeader.tsx, rendered by the panel host above the sections.

const anything = ({nodes}: {nodes: readonly {type: string}[]}) => nodes.length > 0 && nodes.every(node => node.type !== 'PAGE');
const frames = ({nodes}: {nodes: readonly {type: string}[]}) => nodes.length > 0 && nodes.every(node => (FRAME_LIKE_TYPES as readonly string[]).includes(node.type));

export const layoutSections: DesignSection[] = [
  // Shown only while a path is edited with points selected (PointSection renders nothing otherwise).
  {id: 'point', order: 19, applies: ({nodes}) => nodes.length === 1, Component: PointSection},
  {id: 'position', order: 20, applies: anything, Component: PositionSection},
  {id: 'size', order: 25, applies: anything, Component: SizeSection},
  {id: 'layout-grid', order: 105, applies: frames, Component: LayoutGridSection},
  {id: 'layer', order: 50, applies: selection => anything(selection) && selection.nodes.every(node => node.type !== 'SLICE'), Component: LayerSection},
  {id: 'export', order: 110, applies: anything, Component: ExportSection},
];
