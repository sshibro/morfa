import type {DesignDocument, Hyperlink, ListType, NodeId, Paint, SceneNode, Style, StyleId, TextProps, TextStyle} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {caretStyleAt, type RunOverride} from '../../../../shared/design/text-edit';
import {applyStyle, detachStyle} from '../../../../shared/design/styles';
import {fontSpecOf} from '../../../../shared/design/text-layout';
import type {Transaction} from '../../../../shared/design/transaction';
import {catalogueFamilies, familyWeights} from '../fonts';
import type {DesignStore, Gesture} from '../store';
import {activeTextEdit, rememberTextStyle, textEditorDeps, type ActiveTextEdit} from '../text-editor/registry';
import {
  boldChange, caseChange, decorationChange, italicChange, letterSpacingStep, lineHeightStep, linkRange, listRange, refillRange, restyleRange, setTextProps, sizeStep, SPACING_STEP, styledPieces,
  weightStep, type StyleChange,
} from '../text-editor/style-ops';
import {userUpdate} from '../user-edit';
import {registerCommand, type Command, type CommandContext} from './registry';

// Text formatting (the "Text" menu, its shortcuts and the "Text" section of the design panel).
// While a text is edited, formatting applies to the editor's selection; a collapsed caret in a
// non-empty text takes it as the style of what is typed next. Otherwise it applies to every
// selected text layer as a whole. Every change is one hand edit (`userUpdate`), so styles detach
// and instance overrides are recorded as for any panel edit.

export type TextTarget = {id: NodeId; start: number; end: number; whole: boolean};

export type TextOp =
  /** Character style: fields, or a function of each piece's style (size steps). */
  | {kind: 'style'; change: StyleChange}
  /** A toggle decided by every piece at once (bold unless all of it already is). */
  | {kind: 'toggle'; make: (pieces: readonly TextStyle[]) => StyleChange}
  | {kind: 'props'; props: Parameters<typeof setTextProps>[2]}
  | {kind: 'list'; type: ListType; toggle?: boolean}
  | {kind: 'link'; link: Hyperlink | null}
  | {kind: 'fills'; fills: Paint[]}
  /** Apply a text style, or detach the one in use (null). */
  | {kind: 'textStyle'; styleId: StyleId | null};

/** The ranges a formatting change acts on: the edited text's selection, or the selected texts whole. */
export function textTargets(store: DesignStore, ids?: readonly NodeId[]): {session: ActiveTextEdit | null; targets: TextTarget[]} {
  const state = store.getState();
  const session = activeTextEdit(store);
  if (session && (!ids || ids.includes(session.id))) {
    const node = state.doc.nodes[session.id];
    if (node?.text) {
      const {start, end} = session.range();
      const length = node.text.characters.length;
      return {session, targets: [{id: session.id, start, end, whole: length === 0 || (start === 0 && end === length)}]};
    }
  }
  const targets: TextTarget[] = [];
  for (const id of ids ?? state.selection) {
    const node = state.doc.nodes[id];
    if (node?.type === 'TEXT' && node.text && !node.locked) targets.push({id, start: 0, end: node.text.characters.length, whole: true});
  }
  return {session: null, targets};
}

export const hasTextTargets = (store: DesignStore) => textTargets(store).targets.length > 0;

/** Weights the family offers: the catalogue's, the user's local fonts', or null when unknown. */
export function familyWeightsOf(store: DesignStore, family: string): readonly number[] | null {
  const local = textEditorDeps(store)?.fonts.families().find(info => info.family === family);
  if (local) return local.weights;
  const font = catalogueFamilies().find(each => each.family === family);
  return font ? familyWeights(font) : null;
}

/** The style each target shows now (one entry per run piece; the caret's style at a caret). */
export function targetStyles(store: DesignStore, targets: readonly TextTarget[], session: ActiveTextEdit | null): TextStyle[] {
  const doc = store.getState().doc;
  const styles: TextStyle[] = [];
  for (const target of targets) {
    const text = doc.nodes[target.id]?.text;
    if (!text) continue;
    if (session && target.start === target.end && !target.whole) {
      styles.push(caretResolved(text, target.start, session.pendingStyle()).style);
      continue;
    }
    for (const piece of styledPieces(text, target.start, target.end)) styles.push(piece.style);
  }
  return styles;
}

/** The caret's style: the pending one, or what typing there would get. */
function caretResolved(text: TextProps, at: number, pending: RunOverride | null | undefined): {override: RunOverride; style: TextStyle} {
  const override = pending !== undefined ? pending ?? {style: {}} : caretStyleAt(text, at) ?? {style: {}};
  const style = {...text.style} as TextStyle;
  for (const [key, value] of Object.entries(override.style ?? {})) if (value !== undefined) (style as Record<string, unknown>)[key] = value;
  return {override, style};
}

/** Applies a formatting change to the text targets. With a gesture (a scrub in the panel) the
 *  change is shown as the gesture's frame; otherwise it is one undo step. Returns false when there
 *  was nothing to change. */
export function applyTextOp(store: DesignStore, op: TextOp, label: string, options: {ids?: readonly NodeId[]; gesture?: Gesture} = {}): boolean {
  const {session, targets} = textTargets(store, options.ids);
  if (!targets.length) return false;
  const doc = store.getState().doc;
  const change: StyleChange | null = op.kind === 'style' ? op.change : op.kind === 'toggle' ? op.make(targetStyles(store, targets, session)) : null;

  // A text just placed and still empty: the change goes into it without making it a layer yet.
  if (session?.amendNew && targets.length === 1 && targets[0].id === session.id && !options.gesture) {
    const used = session.amendNew(node => patchFor(doc, node, targets[0], op, change));
    if (used) {
      const node = store.getState().doc.nodes[session.id];
      if (node?.text && (change || op.kind === 'fills')) rememberTextStyle(store, node.text.style, node.fills);
      return true;
    }
  }

  // A caret in a non-empty text: the change waits for what is typed next.
  const caret = session && targets.length === 1 && targets[0].start === targets[0].end && !targets[0].whole ? targets[0] : null;
  if (caret && (change || op.kind === 'fills')) {
    const text = doc.nodes[caret.id].text!;
    const {override, style} = caretResolved(text, caret.start, session!.pendingStyle());
    let next: RunOverride;
    if (op.kind === 'fills') next = {...override, fills: op.fills};
    else {
      const partial = typeof change === 'function' ? change(style) : change;
      if (!partial) return false;
      next = {...override, style: {...override.style, ...partial}};
    }
    session!.setPendingStyle(next);
    const resolved = caretResolved(text, caret.start, next).style;
    rememberTextStyle(store, resolved, next.fills ?? doc.nodes[caret.id].fills);
    return true;
  }

  const recipe = (tx: Transaction) => {
    for (const target of targets) {
      const node = tx.get(target.id);
      if (!node?.text) continue;
      const patch = patchFor(tx.doc, node, target, op, change);
      if (patch) userUpdate(tx, target.id, patch);
    }
  };
  if (options.gesture) options.gesture.update(recipe);
  else store.transact(label, recipe);
  if (change || op.kind === 'fills') {
    const node = store.getState().doc.nodes[targets[0].id];
    if (node?.text) {
      const at = Math.max(targets[0].start, targets[0].end - 1);
      const piece = styledPieces(node.text, at, Math.max(at, targets[0].end))[0];
      if (piece) rememberTextStyle(store, piece.style, piece.run?.fills ?? node.fills);
    }
  }
  return true;
}

function patchFor(doc: DesignDocument, node: SceneNode, target: TextTarget, op: TextOp, change: StyleChange | null): Partial<SceneNode> | null {
  switch (op.kind) {
    case 'style':
    case 'toggle':
      return change ? restyleRange(node, target.start, target.end, change) : null;
    case 'props':
      return setTextProps(doc, node, op.props);
    case 'list':
      return listRange(node, target.start, target.end, op.type, op.toggle);
    case 'link':
      return linkRange(node, target.start, target.end, op.link);
    case 'fills':
      return refillRange(node, target.start, target.end, op.fills);
    case 'textStyle': {
      if (op.styleId === null) {
        const patch = detachStyle(node, 'text');
        return Object.keys(patch).length ? patch : null;
      }
      const range = target.whole ? undefined : {start: target.start, end: target.end};
      return applyStyle(doc, [node.id], op.styleId, range ? {range} : {}).get(node.id) ?? null;
    }
  }
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────

const run = (ctx: CommandContext, op: TextOp, label: string) => {
  applyTextOp(ctx.store, op, label);
  activeTextEdit(ctx.store)?.focus();
};

const enabled = (ctx: CommandContext) => hasTextTargets(ctx.store);

/** The px an "Auto" line height stands for: the face's ascent and descent (≈1.2 em before it loads). */
function autoLineHeight(ctx: CommandContext, style: TextStyle): number {
  const {ascent, descent} = ctx.store.measurer.metrics(fontSpecOf(style));
  return ascent + descent > 0 ? ascent + descent : style.fontSize * 1.2;
}

function command(id: string, label: string, op: (ctx: CommandContext) => TextOp, shortcut?: Command['shortcut'], repeat = false): Command {
  return {id, label, group: 'text', shortcut, repeat, enabled, run: ctx => run(ctx, op(ctx), label)};
}

export const TEXT_COMMANDS: Command[] = [
  command('text.bold', 'Bold', ctx => ({kind: 'toggle', make: pieces => boldChange(pieces, family => familyWeightsOf(ctx.store, family))}), {code: 'KeyB', mod: true}),
  command('text.italic', 'Italic', () => ({kind: 'toggle', make: italicChange}), {code: 'KeyI', mod: true}),
  command('text.underline', 'Underline', () => ({kind: 'toggle', make: pieces => decorationChange(pieces, 'UNDERLINE')}), {code: 'KeyU', mod: true}),
  command('text.strikethrough', 'Strikethrough', () => ({kind: 'toggle', make: pieces => decorationChange(pieces, 'STRIKETHROUGH')}), {code: 'KeyX', mod: true, shift: true}),
  command('text.list-bulleted', 'Bulleted list', () => ({kind: 'list', type: 'UNORDERED', toggle: true}), {code: 'Digit8', mod: true, shift: true}),
  command('text.list-numbered', 'Numbered list', () => ({kind: 'list', type: 'ORDERED', toggle: true}), {code: 'Digit7', mod: true, shift: true}),
  command('text.align-left', 'Text align left', () => ({kind: 'props', props: {textAlignHorizontal: 'LEFT'}}), {code: 'KeyL', mod: true, alt: true}),
  command('text.align-center', 'Text align center', () => ({kind: 'props', props: {textAlignHorizontal: 'CENTER'}}), {code: 'KeyT', mod: true, alt: true}),
  command('text.align-right', 'Text align right', () => ({kind: 'props', props: {textAlignHorizontal: 'RIGHT'}}), {code: 'KeyR', mod: true, alt: true}),
  command('text.align-justify', 'Text align justified', () => ({kind: 'props', props: {textAlignHorizontal: 'JUSTIFIED'}}), {code: 'KeyJ', mod: true, alt: true}),
  command('text.size-increase', 'Increase font size', () => ({kind: 'style', change: sizeStep(1)}), {code: 'Period', mod: true, shift: true}, true),
  command('text.size-decrease', 'Decrease font size', () => ({kind: 'style', change: sizeStep(-1)}), {code: 'Comma', mod: true, shift: true}, true),
  command('text.weight-increase', 'Increase font weight', ctx => ({kind: 'style', change: weightStep(1, family => familyWeightsOf(ctx.store, family))}), {code: 'Period', mod: true, alt: true}, true),
  command('text.weight-decrease', 'Decrease font weight', ctx => ({kind: 'style', change: weightStep(-1, family => familyWeightsOf(ctx.store, family))}), {code: 'Comma', mod: true, alt: true}, true),
  // Figma's ⌥> ⌥< and ⌥⇧> ⌥⇧< (the < and > keys, which are letter keys on the Russian layout). Figma's help names the
  // keys but no step; one press is one ↑/↓ step of the "Text" section's field.
  command('text.letter-spacing-increase', 'Increase letter spacing', () => ({kind: 'style', change: letterSpacingStep(SPACING_STEP)}), {code: 'Period', alt: true}, true),
  command('text.letter-spacing-decrease', 'Decrease letter spacing', () => ({kind: 'style', change: letterSpacingStep(-SPACING_STEP)}), {code: 'Comma', alt: true}, true),
  command('text.line-height-increase', 'Increase line height', ctx => ({kind: 'style', change: lineHeightStep(SPACING_STEP, style => autoLineHeight(ctx, style))}), {code: 'Period', alt: true, shift: true}, true),
  command('text.line-height-decrease', 'Decrease line height', ctx => ({kind: 'style', change: lineHeightStep(-SPACING_STEP, style => autoLineHeight(ctx, style))}), {code: 'Comma', alt: true, shift: true}, true),
  command('text.case-upper', 'UPPERCASE', () => ({kind: 'toggle', make: pieces => caseChange(pieces, 'UPPER')})),
  command('text.case-lower', 'lowercase', () => ({kind: 'toggle', make: pieces => caseChange(pieces, 'LOWER')})),
];

let registered = false;

/** Registers the "Text" commands (idempotent). */
export function registerTextCommands() {
  if (registered) return;
  registered = true;
  for (const each of TEXT_COMMANDS) registerCommand(each);
}

// ── Styles and fonts from the panel ────────────────────────────────────────────────────────────

/** "Create style": a text style from `style` (the selection's look), applied where the selection is. */
export function createTextStyle(store: DesignStore, name: string, style: TextStyle, ids?: readonly NodeId[]): StyleId | null {
  const {targets} = textTargets(store, ids);
  if (!targets.length) return null;
  const {hyperlink: _link, ...look} = style;
  void _link;
  const created: Style = {id: newId(), type: 'TEXT', name: name.trim() || 'Text', description: '', text: look as TextStyle};
  store.transact('New text style', tx => {
    tx.setStyle(created);
    for (const target of targets) {
      const range = target.whole || target.start === target.end ? undefined : {start: target.start, end: target.end};
      const patch = applyStyle(tx.doc, [target.id], created.id, range ? {range} : {}).get(target.id);
      if (patch) userUpdate(tx, target.id, patch);
    }
  });
  activeTextEdit(store)?.focus();
  return created.id;
}

/** "Replace font": every character set in `from` (a font this computer lacks) gets `to`, over
 *  the whole of each text. */
export function replaceFontFamily(store: DesignStore, ids: readonly NodeId[], from: string, to: string): void {
  const doc = store.getState().doc;
  const targets = ids.filter(id => doc.nodes[id]?.type === 'TEXT');
  if (!targets.length) return;
  store.transact('Replace font', tx => {
    for (const id of targets) {
      const node = tx.get(id);
      if (!node?.text) continue;
      const patch = restyleRange(node, 0, node.text.characters.length, style => (style.fontFamily === from ? {fontFamily: to} : null));
      if (patch) userUpdate(tx, id, patch);
    }
  });
}
