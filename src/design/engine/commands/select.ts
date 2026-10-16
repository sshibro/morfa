import type {SceneNode} from '../../../../shared/design/types';
import {childSelection, parentSelection, siblingSelection} from '../selection';
import type {Command, CommandContext} from './registry';
import {startMultiEditText} from '../text-multi-edit';

// Select parent, Select children (Enter: several texts are edited as one), Next and previous layer.

const state = (ctx: CommandContext) => ctx.store.getState();
const EDITABLE_SHAPES = new Set<SceneNode['type']>(['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE']);

function selectChildren(ctx: CommandContext) {
  const {doc, selection} = state(ctx);
  const next = childSelection(doc, selection);
  if (next) {
    ctx.store.setSelection(next.selection);
    ctx.store.setContext(next.context);
    return;
  }
  // Enter on several texts edits them as one (text-multi-edit.ts), as Figma's Multi-edit text.
  if (selection.length > 1 && ctx.enterEdit && !state(ctx).ui.devMode) {
    const enter = ctx.enterEdit;
    if (startMultiEditText(ctx.store, selection, id => enter(id, 'text'))) return;
  }
  // Enter on a single text or shape opens its editor, as a double click does (not in "Code", where the file is inspected).
  const node = selection.length === 1 ? doc.nodes[selection[0]] : undefined;
  if (!node || node.locked || !ctx.enterEdit || state(ctx).ui.devMode) return;
  if (node.type === 'TEXT') ctx.enterEdit(node.id, 'text');
  else if (EDITABLE_SHAPES.has(node.type)) ctx.enterEdit(node.id, 'vector');
}

function step(ctx: CommandContext, dir: 1 | -1) {
  const {doc, selection, pageId, context} = state(ctx);
  ctx.store.setSelection(siblingSelection(doc, selection, pageId, context, dir));
}

export const SELECT_COMMANDS: Command[] = [
  {
    id: 'select-parent',
    label: 'Select parent',
    group: 'select',
    shortcut: {code: 'Enter', shift: true},
    enabled: ctx => state(ctx).selection.length > 0,
    run: ctx => {
      const {doc, selection, pageId} = state(ctx);
      const next = parentSelection(doc, selection, pageId);
      if (!next.selection.length) return;
      ctx.store.setSelection(next.selection);
      ctx.store.setContext(next.context);
    },
  },
  {
    id: 'select-children',
    label: 'Select children',
    group: 'select',
    shortcut: {code: 'Enter'},
    alternates: [{code: 'NumpadEnter'}],
    enabled: ctx => state(ctx).selection.length > 0,
    run: selectChildren,
  },
  {id: 'select-next', label: 'Next layer', group: 'select', shortcut: {code: 'Tab'}, repeat: true, run: ctx => step(ctx, 1)},
  {id: 'select-previous', label: 'Previous layer', group: 'select', shortcut: {code: 'Tab', shift: true}, repeat: true, run: ctx => step(ctx, -1)},
];
