import type {NodeId} from '../../../../shared/design/types';
import {isLockedInTree} from '../../../../shared/design/tree';
import {userUpdate} from '../user-edit';
import type {Command, CommandContext} from './registry';

// Figma's number keys: with layers selected, 1…9 set their opacity to 10…90 % and 0 to 100 %; two
// digits typed quickly set it exactly ("5", "5" → 55 %, "0", "5" → 5 %, "0", "0" → 0 %). Both presses
// make one undo step. Digits typed into a text or a field never reach these (keyboard.ts).

/** A second digit within this long after the first makes a two-digit value. */
export const OPACITY_PAIR_MS = 600;

let pending: {digit: number; time: number; selection: readonly NodeId[]} | null = null;

/** The opacity (0…1) a digit press sets, given the previous press. Exported for tests. */
export function opacityForDigit(digit: number, previous: {digit: number; time: number} | null, now: number): {value: number; pair: boolean} {
  if (previous && now - previous.time <= OPACITY_PAIR_MS) return {value: (previous.digit * 10 + digit) / 100, pair: true};
  return {value: digit === 0 ? 1 : digit / 10, pair: false};
}

const targets = (ctx: CommandContext) => {
  const {doc, selection} = ctx.store.getState();
  return selection.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE' && !isLockedInTree(doc, id));
};

export function setOpacityByDigit(ctx: CommandContext, digit: number, now = Date.now()) {
  const ids = targets(ctx);
  if (!ids.length) return;
  const selection = ctx.store.getState().selection;
  const previous = pending && pending.selection === selection ? pending : null;
  const {value, pair} = opacityForDigit(digit, previous, now);
  // A pair ends the sequence; a single digit may still become the first of one.
  pending = pair ? null : {digit, time: now, selection};
  ctx.store.transact('Opacity', tx => {
    for (const id of ids) if (tx.get(id)?.opacity !== value) userUpdate(tx, id, {opacity: value});
  }, {coalesce: 'opacity-digits'});
}

export const OPACITY_COMMANDS: Command[] = Array.from({length: 10}, (_, digit): Command => ({
  id: `opacity-${digit}`,
  label: digit === 0 ? 'Opacity 100%' : `Opacity ${digit * 10}%`,
  group: 'layer',
  hidden: true,
  shortcut: {code: `Digit${digit}`},
  alternates: [{code: `Numpad${digit}`}],
  enabled: ctx => targets(ctx).length > 0,
  run: ctx => setOpacityByDigit(ctx, digit),
}));
