import {DrawTool} from './draw-common';

// "Section" (⇧S): a section on the canvas (or inside another section, never in a frame) that takes in
// the frames and layers it is drawn around.

export const createSectionTool = () => new DrawTool({id: 'section', type: 'SECTION', adopt: true});
