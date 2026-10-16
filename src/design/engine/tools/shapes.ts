import {DrawTool} from './draw-common';

// "Rectangle" (R), "Ellipse" (O), "Line" (L), "Arrow" (⇧L), "Polygon" and "Star":
// draw-common.ts does the drawing; these only say what is drawn. An arrow is a LINE with an arrow
// at its end, as in Figma.

export const createRectangleTool = () => new DrawTool({id: 'rectangle', type: 'RECTANGLE'});
export const createEllipseTool = () => new DrawTool({id: 'ellipse', type: 'ELLIPSE'});
export const createLineTool = () => new DrawTool({id: 'line', type: 'LINE', line: true});
export const createArrowTool = () => new DrawTool({id: 'arrow', type: 'LINE', label: 'Arrow', line: true, props: {strokeEndMarker: 'LINE_ARROW'}});
export const createPolygonTool = () => new DrawTool({id: 'polygon', type: 'POLYGON'});
export const createStarTool = () => new DrawTool({id: 'star', type: 'STAR'});
