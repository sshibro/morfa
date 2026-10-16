import {DrawTool} from './draw-common';

// "Slice" (S): an area to export, drawn like a shape. It has no paint of its own and takes nothing in.

export const createSliceTool = () => new DrawTool({id: 'slice', type: 'SLICE'});
