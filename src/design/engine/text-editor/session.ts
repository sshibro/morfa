import type {NodeId, Paint, SceneNode, TextProps, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {layoutText, offsetAt, caretAt as caretBox, type TextLayout} from '../../../../shared/design/text-layout';
import {textLayoutBounds} from '../../../../shared/design/bounds';
import {caretOnPath, hitsTextPath, straightPoint, textPathLayout} from '../../../../shared/design/text-path';
import type {RunOverride} from '../../../../shared/design/text-edit';
import {propertyForField, setInstanceProperty} from '../../../../shared/design/components';
import {defaultTextProps, TYPE_NAMES} from '../../../../shared/design/defaults';
import type {Transaction} from '../../../../shared/design/transaction';
import {findByShortcut, isEnabled, type CommandContext} from '../commands/registry';
import {isMacPlatform} from '../keyboard';
import type {DesignStore, Gesture} from '../store';
import type {ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../tools/types';
import {userUpdate} from '../user-edit';
import {copyRange, parseClip, pasteClip, pastePlain, RICH_TEXT_MIME, serializeClip, type RichClip} from './clipboard';
import {caretColor, drawTextEditing} from './draw';
import {
  actionForKey, beginComposition, clampSelection, composeText, deleteAt, extendByUnit, insertAt, isCollapsed, moveSelection, nextBurst, paragraphSelection,
  selectionAfterChange, selectionRange, selectionThroughEdit, wordSelection, type Burst, type Composition, type EditKind, type EditorAction, type EditorKey, type TextSelection,
} from './model';
import {activeTextEdit, notifyTextEditing, rememberTextStyle, setActiveTextEdit, type ActiveTextEdit, type TextEditorDeps} from './registry';
import {canLinkText, requestTextLink, textLinkFor} from './link-request';
import {linkRange, styledPieces} from './style-ops';

// One text being edited on the canvas (docs/design-tool.md §Client engine): the text tool owns a
// session while `state.editing` is this text. Keys and IME input arrive through a hidden textarea
// placed at the caret (so the system's composition window opens next to it); the session turns
// them into edits of the node's `TextProps` (model.ts) and writes each through the store as a hand
// edit (`userUpdate`), so undo, autosave, instance overrides and auto-resize all apply. Typing
// bursts share an undo step; ⌘Z inside the editor walks them back one by one.

export type EndReason = 'commit' | 'tool' | 'external';

/** A text the text tool has just placed: shown by an uncommitted gesture until its first character,
 *  so a click that types nothing leaves neither a layer nor an undo step. */
export type Creation = {gesture: Gesture; parentId: NodeId; index: number | undefined; node: SceneNode};

export type SessionOptions = {
  /** Where the caret starts: everything selected (double click, Enter) or an offset (text tool click). */
  select?: 'all' | {offset: number; affinity?: 'upstream' | 'downstream'};
  creation?: Creation;
  onEnd?: (reason: EndReason, session: TextEditSession) => void;
};

const BLINK_MS = 530;
/** Keep this much room between the caret and the canvas edge when following it (CSS px). */
const FOLLOW_MARGIN = 48;
/** The default name of a text layer (shared/design/defaults.ts): a layer still called that is renamed after its words. */
const TEXT_NAME = TYPE_NAMES.TEXT;
/** Commands that may run while a text is typed into: formatting, view, file. Edits of the layer
 *  structure (⌘D, ⌘G…) are swallowed so they never act on a layer that is being typed into. */
const ALLOWED_COMMANDS = /^(text|view|file|app|help)\./;

let serial = 0;
/** The last rich copy: some browsers drop private clipboard types, so a paste of the same plain
 *  text still gets its styles back. */
let lastCopy: {plain: string; clip: RichClip} | null = null;

const truncatedAsNone = new WeakMap<TextProps, TextProps>();

/** A TRUNCATE text shows every line while it is edited. */
export function displayNodeOf(node: SceneNode): SceneNode {
  const text = node.text;
  if (!text || text.textAutoResize !== 'TRUNCATE') return node;
  let shown = truncatedAsNone.get(text);
  if (!shown) truncatedAsNone.set(text, (shown = {...text, textAutoResize: 'NONE'}));
  return {...node, text: shown};
}

/** A name that follows the text while it has never been renamed (Figma names text layers after
 *  their words). */
export function autoName(characters: string): string {
  const flat = characters.replace(/[\n\u2028\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 120) : TEXT_NAME;
}

export class TextEditSession implements ActiveTextEdit {
  readonly id: NodeId;
  private readonly key = `t${++serial}`;
  private readonly mac = isMacPlatform();
  private selection: TextSelection = {anchor: 0, focus: 0, affinity: 'downstream'};
  private pending: RunOverride | null | undefined = undefined;
  private composing: {composition: Composition; gesture: Gesture; range: {start: number; end: number}} | null = null;
  private burst: Burst | null = null;
  private serial = 0;
  private creation: Creation | null;
  /** The text as the session last saw it in the store. */
  private text: TextProps;
  /** Above zero while the session itself writes to the store. */
  private quiet = 0;
  private drag: {unit: 'char' | 'word' | 'paragraph'; origin: TextSelection} | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private focused = false;
  private caretOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cleanups: (() => void)[] = [];
  private ctx: ToolContext | null = null;
  private ended = false;
  private cache: {node: SceneNode; display: SceneNode; layout: TextLayout; revision: unknown} | null = null;

  constructor(readonly store: DesignStore, id: NodeId, private readonly deps: TextEditorDeps, private readonly options: SessionOptions = {}) {
    this.id = id;
    this.creation = options.creation ?? null;
    const node = store.getState().doc.nodes[id];
    // The tool opens a session only on a text that is in the document (a new one already is,
    // through its creation gesture).
    this.text = node?.text ?? options.creation?.node.text ?? defaultTextProps('');
    const length = this.text.characters.length;
    const select = options.select ?? 'all';
    this.selection = select === 'all' ? {anchor: 0, focus: length, affinity: 'downstream'} : clampSelection({anchor: select.offset, focus: select.offset, affinity: select.affinity ?? 'downstream'}, length);
    this.cleanups.push(store.subscribe(() => this.onStore(), {slice: ['doc', 'editing', 'page', 'selection']}));
    if (store.getState().selection.length !== 1 || store.getState().selection[0] !== id) store.setSelection([id]);
    setActiveTextEdit(store, this);
  }

  // ── State ────────────────────────────────────────────────────────────────────────────────────

  get isEnded() {
    return this.ended;
  }

  node(): SceneNode | undefined {
    const node = this.store.getState().doc.nodes[this.id];
    return node?.text ? node : undefined;
  }

  /** The node as it is drawn and hit-tested while edited, and its layout. */
  view(): {node: SceneNode; display: SceneNode; layout: TextLayout} | null {
    const node = this.node();
    if (!node) return null;
    const revision = this.store.measurer.revision;
    const cached = this.cache;
    if (cached && cached.node === node && cached.revision === revision) return cached;
    const display = displayNodeOf(node);
    this.cache = {node, display, layout: layoutText(display, this.store.measurer), revision};
    return this.cache;
  }

  range() {
    return selectionRange(this.selection);
  }

  pendingStyle() {
    return this.pending;
  }

  setPendingStyle(style: RunOverride | null | undefined) {
    this.pending = style;
    this.changed();
  }

  amendNew(make: (node: SceneNode) => Partial<SceneNode> | null): boolean {
    const creation = this.creation;
    if (!creation?.gesture.active) return false;
    const patch = make(creation.node);
    if (!patch) return true;
    const node = {...creation.node, ...patch} as SceneNode;
    for (const key of Object.keys(patch) as (keyof SceneNode)[]) if (patch[key] === undefined) delete node[key];
    creation.node = node;
    this.quiet++;
    try {
      creation.gesture.update(tx => {
        tx.create(node, creation.parentId, creation.index);
        return {select: [this.id]};
      });
    } finally {
      this.quiet--;
    }
    const shown = this.node();
    if (shown?.text) this.text = shown.text;
    this.changed();
    return true;
  }

  /** The text tool hands the session its canvas when it opens it (and again after a tool switch). */
  attach(ctx: ToolContext) {
    this.ctx = ctx;
    if (!this.textarea) this.mount();
    this.focus();
    this.changed();
  }

  focus() {
    if (this.ended) return;
    this.textarea?.focus({preventScroll: true});
  }

  anchor(): Element | null {
    return this.ended ? null : this.textarea;
  }

  // ── Writing ──────────────────────────────────────────────────────────────────────────────────

  /** Writes `next` as the node's text: the first characters of a new text create the layer, a
   *  text bound to a component property sets the property on its instance, anything else is a
   *  hand edit of the node. `kind` decides the undo step it joins. */
  private write(next: TextProps, selection: TextSelection, kind: EditKind, label: string, inserted = '', extra: Partial<SceneNode> = {}) {
    const node = this.node();
    if (!node?.text) return;
    const burst = kind === 'other' ? null : nextBurst(this.burst, kind, inserted, this.serial);
    if (burst) this.serial = burst.serial;
    const coalesce = burst ? `text:${this.key}:${burst.serial}` : undefined;
    this.quiet++;
    try {
      const creation = this.creation;
      if (creation?.gesture.active) {
        creation.gesture.cancel();
        this.creation = null;
        const created: SceneNode = {...creation.node, ...extra, text: next, name: autoName(next.characters)};
        this.store.transact('Text', tx => tx.create(created, creation.parentId, creation.index), {select: [this.id], coalesce});
        this.store.setEditing({kind: 'text', id: this.id});
      } else {
        this.creation = null;
        const changesCharacters = node.text.characters !== next.characters;
        this.store.transact(label, tx => {
          if (changesCharacters && this.writeProperty(tx, next.characters)) return;
          const patch: Partial<SceneNode> = {...extra, text: next};
          if (changesCharacters && node.mainId === undefined && (node.name === TEXT_NAME || node.name === autoName(node.text!.characters))) patch.name = autoName(next.characters);
          userUpdate(tx, this.id, patch);
        }, {coalesce});
      }
    } finally {
      this.quiet--;
    }
    this.burst = burst;
    this.pending = undefined;
    this.syncFromStore(selection);
    this.follow();
  }

  /** Typing into a text a component property drives (inside an instance) changes the property. */
  private writeProperty(tx: Transaction, characters: string): boolean {
    const bound = propertyForField(tx.doc, this.id, 'characters');
    if (!bound) return false;
    try {
      const result = setInstanceProperty(tx.doc, bound.instanceId, bound.key, characters);
      for (const id of result.changed) {
        const after = result.doc.nodes[id];
        if (!after) continue;
        const {id: _id, parentId: _parent, children: _children, ...fields} = after;
        void _id;
        void _parent;
        void _children;
        const before = tx.get(id);
        const cleared: Partial<SceneNode> = {...fields};
        if (before) for (const key of Object.keys(before)) if (!(key in after)) (cleared as Record<string, unknown>)[key] = undefined;
        tx.update(id, cleared);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Reads the node back after a write (normalization may have resized it) and settles the selection. */
  private syncFromStore(selection: TextSelection) {
    const node = this.node();
    if (!node?.text) return;
    this.text = node.text;
    this.selection = clampSelection(selection, node.text.characters.length);
    this.changed();
  }

  /** Something other than the session changed the store: undo, the panel, a page switch, the
   *  selection. */
  private onStore() {
    if (this.quiet || this.ended) return;
    const state = this.store.getState();
    const node = state.doc.nodes[this.id];
    if (this.creation && !this.creation.gesture.active) this.creation = null;
    // Gone, editing something else, or another layer picked (the layers panel): Figma leaves too.
    if (!node?.text || state.editing?.kind !== 'text' || state.editing.id !== this.id || state.selection.length !== 1 || state.selection[0] !== this.id) {
      this.end('external');
      return;
    }
    if (node.text !== this.text) {
      const before = this.text.characters;
      this.text = node.text;
      if (before !== node.text.characters) {
        // Someone else typed in this text (co-editing): the caret stays on the same characters and the typing goes on.
        if (this.store.changeSource?.() === 'remote') this.selection = selectionThroughEdit(before, node.text.characters, this.selection);
        else {
          this.selection = selectionAfterChange(before, node.text.characters, this.selection);
          this.pending = undefined;
          this.burst = null;
        }
      } else {
        this.selection = clampSelection(this.selection, node.text.characters.length);
      }
      this.changed();
    }
  }

  /** The selection or the text moved: the panel, the caret and the hidden field follow. */
  private changed() {
    if (this.ended) return;
    this.caretOn = true;
    this.restartBlink();
    this.placeTextarea();
    notifyTextEditing(this.store);
    this.ctx?.requestOverlay();
  }

  // ── Actions ──────────────────────────────────────────────────────────────────────────────────

  perform(action: EditorAction) {
    const current = this.view();
    if (!current) return;
    const {layout} = current;
    const text = this.text;
    switch (action.type) {
      case 'move':
        this.select(moveSelection(text.characters, layout, this.selection, action.to, action.extend));
        this.follow();
        return;
      case 'selectAll':
        this.select({anchor: 0, focus: text.characters.length, affinity: 'downstream'});
        return;
      case 'insert':
        this.insert(action.text);
        return;
      case 'delete': {
        const result = deleteAt(text, layout, this.selection, action.direction, action.unit);
        if (result) this.write(result.text, result.selection, result.kind, 'Delete text');
        return;
      }
      case 'undo':
      case 'redo':
        if (this.creation?.gesture.active) {
          // Nothing typed yet: undo just takes the new text away.
          this.exit();
          return;
        }
        this.burst = null;
        if (action.type === 'undo') this.store.undo();
        else this.store.redo();
        return;
      case 'exit':
        this.exit();
        return;
    }
  }

  /** Types `value` over the selection in the caret's style. */
  insert(value: string) {
    const result = insertAt(this.text, this.selection, value, this.pending);
    if (!result) {
      this.limitReached();
      return;
    }
    this.write(result.text, result.selection, result.kind, 'Type text', value);
  }

  private limitReached() {
    this.deps.toast?.('A single text can hold at most 100,000 characters.', 'error');
  }

  select(selection: TextSelection) {
    const length = this.text.characters.length;
    this.selection = clampSelection(selection, length);
    this.pending = undefined;
    this.burst = null;
    this.changed();
  }

  /** Esc: leaves the text selected, as Figma does. */
  exit() {
    this.end('commit');
  }

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────────

  /** A key the editor handles itself, or a formatting/view command it lets through. Returns true
   *  when the key was used. */
  handleKey(event: EditorKey): boolean {
    const action = actionForKey(event, this.mac);
    if (action) {
      this.perform(action);
      return true;
    }
    // ⌘K: the link field for the selected words, as in Figma (a caret inside a link edits that link).
    if (event.code === 'KeyK' && (this.mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) {
      if (canLinkText(this.store)) requestTextLink(this.store);
      return true;
    }
    // Plain and Shift-ed keys type (⇧H is a character here, not "Flip"); ⌥ types accents on a Mac,
    // except on the < and > keys, where ⌥ and ⌥⇧ step letter spacing and line height, as in Figma.
    const spacing = event.altKey && (event.code === 'Comma' || event.code === 'Period');
    if (!event.metaKey && !event.ctrlKey && !spacing) return false;
    const context = this.commandContext();
    const allowed = (candidate: {id: string; group?: string}) => ALLOWED_COMMANDS.test(candidate.id) || candidate.group === 'view';
    // A key two commands share goes to the one that applies while typing (the text's own first).
    const command = findByShortcut(event, this.mac, candidate => allowed(candidate) && isEnabled(candidate, context));
    if (!command || command.clipboardEvent) return false;
    if (allowed(command) && isEnabled(command, context)) void command.run(context);
    return true;
  }

  /** Keys that reached the canvas while the hidden field was not focused (a panel button took the
   *  focus): editing keys work, a typed character goes in, and the field gets the focus back. */
  keyFromCanvas(event: ToolKeyEvent): boolean {
    if (event.type !== 'keydown') return false;
    const used = this.handleKey(event);
    if (!used && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      this.insert(event.key);
      this.focus();
      return true;
    }
    if (used) this.focus();
    return used;
  }

  private commandContext(): CommandContext {
    return {store: this.store, canvasSize: () => this.ctx?.view.size() ?? {width: 0, height: 0}};
  }

  // ── Pointer ──────────────────────────────────────────────────────────────────────────────────

  /** The point in the text's own space, and whether it is on the text (its box or its lines). */
  hit(page: Vec, tolerance: number): {inside: boolean; local: Vec} | null {
    const current = this.view();
    if (!current) return null;
    const {node, layout} = current;
    const local = apply(invert(worldMatrix(this.store.getState().doc, this.id)), page);
    if (current.display.textPath) {
      // A text on a path: on its glyphs or near its path, and the point as one of the unwrapped line, where the caret goes.
      const placed = textPathLayout(current.display, layout);
      const straight = straightPoint(placed, layout, local);
      const size = current.display.text?.style.fontSize ?? 16;
      return {inside: hitsTextPath(placed, layout, local, tolerance + size * 0.25), local: straight ? {x: straight.x, y: straight.y} : local};
    }
    const lines = textLayoutBounds(layout);
    const left = Math.min(0, lines?.x ?? 0), top = Math.min(0, lines?.y ?? 0);
    const right = Math.max(node.width, lines ? lines.x + lines.width : 0), bottom = Math.max(node.height, lines ? lines.y + lines.height : 0);
    const inside = local.x >= left - tolerance && local.x <= right + tolerance && local.y >= top - tolerance && local.y <= bottom + tolerance;
    return {inside, local};
  }

  pointerDown(e: ToolPointerEvent, local: Vec) {
    const current = this.view();
    if (!current) return;
    const chars = this.text.characters;
    const hit = offsetAt(current.layout, local);
    const clicks = ((e.detail - 1) % 4) + 1;
    if (clicks >= 4) {
      this.select({anchor: 0, focus: chars.length, affinity: 'downstream'});
      this.drag = null;
    } else if (clicks === 3) {
      const paragraph = paragraphSelection(chars, hit.offset);
      this.select(paragraph);
      this.drag = {unit: 'paragraph', origin: paragraph};
    } else if (clicks === 2) {
      const word = wordSelection(chars, hit.offset);
      this.select(word);
      this.drag = {unit: 'word', origin: word};
    } else if (e.shiftKey) {
      this.select({anchor: this.selection.anchor, focus: hit.offset, affinity: hit.affinity});
      this.drag = {unit: 'char', origin: {anchor: this.selection.anchor, focus: this.selection.anchor, affinity: 'downstream'}};
    } else {
      const caret = {anchor: hit.offset, focus: hit.offset, affinity: hit.affinity};
      this.select(caret);
      this.drag = {unit: 'char', origin: caret};
    }
    this.focus();
  }

  pointerMove(local: Vec) {
    const drag = this.drag;
    const current = this.view();
    if (!drag || !current) return;
    const hit = offsetAt(current.layout, local);
    const next = drag.unit === 'char'
      ? {anchor: drag.origin.anchor, focus: hit.offset, affinity: hit.affinity}
      : extendByUnit(this.text.characters, drag.origin, hit.offset, drag.unit);
    if (next.anchor === this.selection.anchor && next.focus === this.selection.focus) return;
    this.selection = next;
    this.pending = undefined;
    this.burst = null;
    this.changed();
  }

  pointerUp() {
    this.drag = null;
    // The press's own mousedown moved the focus to the page (the canvas cannot hold it): take it back.
    this.focus();
    this.mirror();
  }

  // ── Drawing ──────────────────────────────────────────────────────────────────────────────────

  draw(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const current = this.view();
    if (!current) return;
    const {start, end} = this.range();
    const showCaret = start === end && this.caretOn && this.focused && !this.composing;
    const pieces = styledPieces(this.text, start, start);
    const fills: readonly Paint[] = this.pending?.fills ?? pieces[0]?.run?.fills ?? current.node.fills;
    drawTextEditing(ctx2d, {
      doc: this.store.getState().doc,
      node: current.node,
      display: current.display,
      layout: current.layout,
      selection: {start, end},
      caret: showCaret || (this.composing && this.focused) ? {offset: this.selection.focus, affinity: this.selection.affinity} : null,
      composition: this.composing?.range ?? null,
      viewport: view.viewport(),
      deps: this.deps,
    }, caretColor(fills));
    this.placeTextarea(view);
  }

  // ── Following the caret ──────────────────────────────────────────────────────────────────────

  /** The caret in CSS px of the canvas. */
  private caretOnScreen(view: ViewHelpers): {x: number; y: number; height: number} | null {
    const current = this.view();
    if (!current) return null;
    const box = caretBox(current.layout, this.selection.focus, this.selection.affinity);
    const world = worldMatrix(this.store.getState().doc, this.id);
    const ends = current.display.textPath ? caretOnPath(textPathLayout(current.display, current.layout), box) : null;
    const top = view.pageToScreen(apply(world, ends?.top ?? {x: box.x, y: box.top}));
    const bottom = view.pageToScreen(apply(world, ends?.bottom ?? {x: box.x, y: box.top + box.height}));
    return {x: top.x, y: Math.min(top.y, bottom.y), height: Math.abs(bottom.y - top.y)};
  }

  /** Scrolls the canvas so the caret stays in view while typing or moving with the keys. */
  private follow() {
    const view = this.ctx?.view;
    if (!view) return;
    const caret = this.caretOnScreen(view);
    if (!caret) return;
    const size = view.size();
    if (!size.width || !size.height) return;
    let dx = 0, dy = 0;
    const margin = Math.min(FOLLOW_MARGIN, size.width / 4, size.height / 4);
    if (caret.x < margin) dx = caret.x - margin;
    else if (caret.x > size.width - margin) dx = caret.x - (size.width - margin);
    if (caret.y < margin) dy = caret.y - margin;
    else if (caret.y + caret.height > size.height - margin) dy = Math.min(caret.y - margin, caret.y + caret.height - (size.height - margin));
    if (!dx && !dy) return;
    const viewport = view.viewport();
    view.setViewport({x: viewport.x + dx / viewport.zoom, y: viewport.y + dy / viewport.zoom, zoom: viewport.zoom});
  }

  // ── The hidden field ─────────────────────────────────────────────────────────────────────────

  private mount() {
    if (typeof document === 'undefined') return;
    const host = this.deps.host?.() ?? document.querySelector<HTMLElement>('.dz-canvas');
    if (!host) return;
    const field = document.createElement('textarea');
    field.className = 'dz-text-input';
    field.setAttribute('aria-label', 'Text editing');
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('autocorrect', 'off');
    field.setAttribute('autocapitalize', 'off');
    field.spellcheck = false;
    field.wrap = 'off';
    Object.assign(field.style, {
      position: 'absolute', left: '0px', top: '0px', width: '2px', height: '16px', padding: '0', margin: '0', border: '0', outline: 'none', resize: 'none',
      overflow: 'hidden', opacity: '0', pointerEvents: 'none', whiteSpace: 'pre', fontSize: '16px', lineHeight: '1', color: 'transparent',
      background: 'transparent', caretColor: 'transparent', zIndex: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(field);
    this.textarea = field;
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
      field.addEventListener(type, handler as EventListener);
      this.cleanups.push(() => field.removeEventListener(type, handler as EventListener));
    };
    on('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (this.handleKey(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    on('beforeinput', event => this.beforeInput(event as InputEvent));
    on('input', () => {
      // Input the beforeinput path did not take (an old engine): read it from the field.
      if (this.composing) return;
      const value = this.textarea?.value ?? '';
      const mirrored = this.mirrored;
      if (value && value !== mirrored) {
        this.insert(value.startsWith(mirrored) ? value.slice(mirrored.length) : value);
      }
      this.mirror();
    });
    on('compositionstart', () => this.compositionStart());
    on('compositionupdate', event => this.compositionUpdate((event as CompositionEvent).data ?? ''));
    on('compositionend', event => this.compositionEnd((event as CompositionEvent).data ?? ''));
    on('copy', event => this.copy(event as ClipboardEvent, false));
    on('cut', event => this.copy(event as ClipboardEvent, true));
    on('paste', event => this.paste(event as ClipboardEvent));
    on('drop', event => event.preventDefault());
    on('focus', () => {
      this.focused = true;
      this.caretOn = true;
      this.restartBlink();
      this.ctx?.requestOverlay();
    });
    on('blur', () => {
      this.focused = false;
      this.flushComposition();
      this.ctx?.requestOverlay();
    });
    this.cleanups.push(() => field.remove());
    this.mirror();
  }

  /** The field holds the selected characters, selected, so the browser's copy and the IME see
   *  what the user sees selected. */
  private mirrored = '';
  private mirror() {
    const field = this.textarea;
    if (!field || this.composing) return;
    const {start, end} = this.range();
    const value = end > start ? this.text.characters.slice(start, Math.min(end, start + 2000)) : '';
    this.mirrored = value;
    if (field.value !== value) field.value = value;
    if (document.activeElement === field) field.setSelectionRange(0, value.length);
  }

  private placeTextarea(view: ViewHelpers | undefined = this.ctx?.view) {
    const field = this.textarea;
    if (!field || !view) return;
    this.mirror();
    const caret = this.caretOnScreen(view);
    if (!caret) return;
    const size = view.size();
    // Inside the canvas, or focusing it would scroll the canvas container.
    const x = Math.max(0, Math.min(size.width - 4, caret.x));
    const height = Math.max(8, Math.min(caret.height, 200));
    const y = Math.max(0, Math.min(size.height - height, caret.y));
    field.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    field.style.height = `${Math.round(height)}px`;
    field.style.fontSize = `${Math.round(Math.max(8, Math.min(height * 0.8, 64)))}px`;
    const host = field.parentElement;
    if (host && (host.scrollLeft || host.scrollTop)) {
      host.scrollLeft = 0;
      host.scrollTop = 0;
    }
  }

  private beforeInput(event: InputEvent) {
    if (this.composing || event.isComposing) return;
    const type = event.inputType;
    const data = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
    switch (type) {
      case 'insertText':
      case 'insertReplacementText':
        event.preventDefault();
        if (data) this.insert(data);
        return;
      case 'insertLineBreak':
        event.preventDefault();
        this.insert('\u2028');
        return;
      case 'insertParagraph':
        event.preventDefault();
        this.insert('\n');
        return;
      case 'insertFromPaste':
      case 'insertFromDrop':
      case 'insertFromYank':
        // The paste listener handles pastes; drops of outside text are not taken.
        event.preventDefault();
        return;
      case 'deleteContentBackward':
      case 'deleteContentForward':
      case 'deleteWordBackward':
      case 'deleteWordForward':
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward': {
        event.preventDefault();
        const backward = type.endsWith('Backward');
        const unit = type.includes('Word') ? 'word' : type.includes('Line') ? 'line' : 'char';
        this.perform({type: 'delete', direction: backward ? 'backward' : 'forward', unit});
        return;
      }
      case 'historyUndo':
        event.preventDefault();
        this.perform({type: 'undo'});
        return;
      case 'historyRedo':
        event.preventDefault();
        this.perform({type: 'redo'});
        return;
      default:
        // Formatting from the system (bold in Safari's menu, …) and anything else: the editor's
        // own commands do formatting.
        event.preventDefault();
    }
  }

  // ── Composition ──────────────────────────────────────────────────────────────────────────────

  private compositionStart() {
    if (this.composing) return;
    const {start, end} = this.range();
    if (end > start) {
      // The draft replaces the selection: removing it first is part of typing.
      const result = beginComposition(this.text, this.selection);
      this.write(result.text, result.selection, 'type', 'Type text');
    }
    if (this.creation?.gesture.active) {
      // A new text becomes a layer when its first draft appears.
      this.write(this.text, this.selection, 'type', 'Text');
    }
    const begun = beginComposition(this.text, this.selection);
    this.composing = {composition: begun.composition, gesture: this.store.gesture('Type text'), range: {start: begun.selection.focus, end: begun.selection.focus}};
    this.ctx?.requestOverlay();
  }

  private compositionUpdate(data: string) {
    const composing = this.composing;
    if (!composing || !composing.gesture.active) return;
    const draft = composeText(composing.composition, data, this.pending);
    this.quiet++;
    try {
      composing.gesture.update(tx => userUpdate(tx, this.id, {text: draft.text}));
    } finally {
      this.quiet--;
    }
    composing.range = draft.range;
    const node = this.node();
    if (node?.text) this.text = node.text;
    this.selection = draft.selection;
    this.cache = null;
    this.changed();
  }

  private compositionEnd(data: string) {
    const composing = this.composing;
    if (!composing) return;
    this.composing = null;
    this.quiet++;
    try {
      composing.gesture.cancel();
    } finally {
      this.quiet--;
    }
    const node = this.node();
    if (node?.text) this.text = node.text;
    const result = data ? composeText(composing.composition, data, this.pending) : null;
    if (result && result.text !== this.text) this.write(result.text, result.selection, 'type', 'Type text', data);
    else this.syncFromStore(composing.composition.start === this.selection.focus ? this.selection : {anchor: composing.composition.start, focus: composing.composition.start, affinity: 'downstream'});
    if (this.textarea) this.textarea.value = '';
    this.mirror();
  }

  /** A composition still open when the editor closes or loses focus keeps its draft. */
  private flushComposition() {
    const composing = this.composing;
    if (!composing) return;
    const range = composing.range;
    const node = this.node();
    const data = node?.text ? node.text.characters.slice(range.start, range.end) : '';
    this.compositionEnd(data);
  }

  // ── Clipboard ────────────────────────────────────────────────────────────────────────────────

  private copy(event: ClipboardEvent, cut: boolean) {
    const node = this.node();
    const {start, end} = this.range();
    if (!node?.text || end <= start) return;
    const copied = copyRange(node.text, node.fills, start, end);
    if (!copied || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', copied.plain);
    try {
      event.clipboardData.setData(RICH_TEXT_MIME, serializeClip(copied.rich));
    } catch {
      // A browser that refuses private types still has the in-memory copy below.
    }
    lastCopy = {plain: copied.plain, clip: copied.rich};
    if (cut) {
      const result = deleteAt(this.text, this.view()!.layout, this.selection, 'backward', 'char');
      if (result) this.write(result.text, result.selection, 'other', 'Cut text');
    }
  }

  private paste(event: ClipboardEvent) {
    event.preventDefault();
    const data = event.clipboardData;
    if (!data) return;
    const plain = data.getData('text/plain');
    let clip = parseClip(data.getData(RICH_TEXT_MIME), plain);
    if (!clip && lastCopy && plain && lastCopy.plain === plain.replace(/\r\n?/g, '\n')) clip = lastCopy.clip;
    const node = this.node();
    if (!node?.text) return;
    const {start, end} = this.range();
    if (clip) {
      const result = pasteClip(this.text, node.fills, start, end, clip);
      if (!result) return this.limitReached();
      const extra: Partial<SceneNode> = result.fills !== node.fills ? {fills: result.fills} : {};
      this.write(result.text, {anchor: result.caret, focus: result.caret, affinity: 'downstream'}, 'other', 'Paste text', '', extra);
      return;
    }
    if (!plain) return;
    // An address pasted over selected words links them, as in Figma (a layer link of this file links to the layer); the words stay.
    const link = start < end && /^\S+$/.test(plain.trim()) && /^(https?:\/\/|www\.)/i.test(plain.trim()) ? textLinkFor(this.store, plain) : null;
    if (link) {
      const {text, ...rest} = linkRange(node, start, end, link) ?? {};
      if (text) this.write(text, this.selection, 'other', 'Link', '', rest);
      return;
    }
    const result = pastePlain(this.text, start, end, plain, this.pending);
    if (!result) return this.limitReached();
    this.write(result.text, {anchor: result.caret, focus: result.caret, affinity: 'downstream'}, 'other', 'Paste text');
  }

  // ── Caret blink ──────────────────────────────────────────────────────────────────────────────

  private restartBlink() {
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    if (this.ended || typeof setInterval === 'undefined') return;
    this.blinkTimer = setInterval(() => {
      if (!this.focused || !isCollapsed(this.selection)) return;
      this.caretOn = !this.caretOn;
      this.ctx?.requestOverlay();
    }, BLINK_MS);
  }

  // ── Ending ───────────────────────────────────────────────────────────────────────────────────

  /** Closes the editor. A text left empty is removed (a new one never becomes a layer). */
  end(reason: EndReason) {
    if (this.ended) return;
    this.flushComposition();
    this.ended = true;
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.textarea = null;
    const store = this.store;
    this.quiet++;
    try {
      const creation = this.creation;
      const node = this.node();
      if (creation?.gesture.active) creation.gesture.cancel();
      // A board object's text (a sticky's, a shape's, a cell's: docs/board.md) is part of it and stays, empty or not.
      else if (node?.text && node.text.characters === '' && !node.board) store.transact('Delete text', tx => tx.remove(this.id), {select: store.getState().selection.filter(id => id !== this.id)});
      else if (node?.text) {
        const at = node.text.characters.length;
        const piece = styledPieces(node.text, at, at)[0];
        rememberTextStyle(store, piece.style, piece.run?.fills ?? node.fills);
      }
      if (store.getState().editing?.id === this.id) store.setEditing(null);
      if (reason === 'commit' && this.node()) store.setSelection([this.id]);
    } finally {
      this.quiet--;
    }
    if (activeTextEdit(store) === this) setActiveTextEdit(store, null);
    this.ctx?.requestOverlay();
    this.options.onEnd?.(reason, this);
  }
}
