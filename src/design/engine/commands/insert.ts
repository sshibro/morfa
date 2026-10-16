import {imageServicesFor, startPlaceImage} from '../tools/image';
import type {Command, Shortcut} from './registry';

// Keys of the drawing tools (physical keys, so they work on any keyboard layout) and "Place image…"
// (⇧⌘K). The toolbar shows the same tools (src/design/editor/chrome/tools.ts); a key only switches
// the store's tool, the canvas then activates the tool module.

const TOOL_KEYS: [tool: string, label: string, shortcut: Shortcut, alternates?: Shortcut[]][] = [
  ['scale', 'Scale', {code: 'KeyK'}],
  ['frame', 'Frame', {code: 'KeyF'}, [{code: 'KeyA'}]],
  ['section', 'Section', {code: 'KeyS', shift: true}],
  ['slice', 'Slice', {code: 'KeyS'}],
  ['rectangle', 'Rectangle', {code: 'KeyR'}],
  ['ellipse', 'Ellipse', {code: 'KeyO'}],
  ['line', 'Line', {code: 'KeyL'}],
  ['arrow', 'Arrow', {code: 'KeyL', shift: true}],
];

export const INSERT_COMMANDS: Command[] = [
  ...TOOL_KEYS.map(([tool, label, shortcut, alternates]): Command => ({
    id: `tool-${tool}`,
    label,
    group: 'tools',
    shortcut,
    ...(alternates ? {alternates} : {}),
    hidden: true,
    run: ctx => ctx.store.setTool(tool),
  })),
  {id: 'tool-polygon', label: 'Polygon', group: 'tools', hidden: true, run: ctx => ctx.store.setTool('polygon')},
  {id: 'tool-star', label: 'Star', group: 'tools', hidden: true, run: ctx => ctx.store.setTool('star')},
  {
    id: 'file.place-image',
    label: 'Place image…',
    group: 'file',
    shortcut: {code: 'KeyK', mod: true, shift: true},
    // Pictures need the open file's upload (bound by the canvas overlay); without it nothing is offered.
    enabled: ctx => !!imageServicesFor(ctx.store),
    run: ctx => startPlaceImage(ctx.store),
  },
];
