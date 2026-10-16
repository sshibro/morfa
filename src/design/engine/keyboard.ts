import {findByShortcut, isEnabled, type CommandContext, type KeyLike, type Shortcut} from './commands/registry';

// Keys on the canvas: window keydowns become commands by physical key (`KeyboardEvent.code`, so
// shortcuts work on the Russian layout), ⌘ on Mac and Ctrl elsewhere. Keys typed into a field, a
// text being edited or an IME composition never reach the canvas.

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/** ⌘ on Mac, Ctrl elsewhere. */
export const modPressed = (event: Pick<KeyLike, 'metaKey' | 'ctrlKey'>, mac = isMacPlatform()) => (mac ? event.metaKey : event.ctrlKey);

/** Focus is somewhere the user types: an input, a textarea, a select or editable content. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & {type?: string}) | null;
  if (!element || typeof element !== 'object' || !('tagName' in element)) return false;
  const tag = String(element.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(String(element.type || 'text').toLowerCase());
  return !!element.isContentEditable || !!element.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
}

/** Keys a field hands on to the document although focus is in it: ⌘Z / ⇧⌘Z / ⌘Y in a property field whose value is
 *  committed (nothing typed since), so the change just made is undone as in Figma instead of the key doing nothing. */
const handed = new WeakSet<Event>();
export function handToDocument(event: Event): void {
  handed.add(event);
}
export const handedToDocument = (event: Event): boolean => handed.has(event);

/** ⌘Z, ⇧⌘Z or ⌘Y (Ctrl elsewhere): the keys `handToDocument` is for. */
export const isUndoKey = (event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey'>, mac = isMacPlatform()): boolean =>
  modPressed(event, mac) && !event.altKey && (event.code === 'KeyZ' || event.code === 'KeyY');

/** Enter pressed on a button, link or checkbox the keyboard brought focus to (Tab, or a swatch focus came
 *  back to after its picker): the control's own, not the canvas's "Select children". A control merely
 *  clicked keeps no keyboard focus ring and leaves Enter to the canvas; Space stays the canvas's (it pans). */
export function pressesFocusedControl(event: Pick<KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const element = event.target as HTMLElement | null;
  if (!element || typeof element !== 'object' || !('tagName' in element)) return false;
  if (!element.matches?.(':focus-visible')) return false;
  const tag = String(element.tagName).toUpperCase();
  if (tag === 'BUTTON' || (tag === 'A' && element.hasAttribute?.('href'))) return true;
  if (tag === 'INPUT') return ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(String((element as HTMLInputElement).type).toLowerCase());
  return /^(button|checkbox|switch|menuitem|menuitemcheckbox|menuitemradio|option|tab|link)$/.test(element.getAttribute?.('role') ?? '');
}

const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  BracketLeft: ['[', '['], BracketRight: [']', ']'], Equal: ['+', '+'], Minus: ['−', '−'], NumpadAdd: ['+', '+'], NumpadSubtract: ['−', '−'],
  Backspace: ['⌫', 'Backspace'], Delete: ['⌦', 'Del'], Enter: ['↩', 'Enter'], NumpadEnter: ['↩', 'Enter'], Escape: ['Esc', 'Esc'], Tab: ['⇥', 'Tab'],
  Space: ['Space', 'Space'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'], ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'],
  Backslash: ['\\', '\\'], Slash: ['/', '/'], Comma: [',', ','], Period: ['.', '.'], Semicolon: [';', ';'], Quote: ["'", "'"], Backquote: ['`', '`'],
};

/** The printed name of a physical key: KeyG → G, Digit1 → 1, BracketRight → ]. */
export function keyLabel(code: string, mac = isMacPlatform()): string {
  const known = KEY_LABELS[code];
  if (known) return known[mac ? 0 : 1];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return code;
}

/** As menus show it: ⌃⌥⇧⌘G on Mac (Apple's order), Ctrl+Shift+Alt+G elsewhere. */
export function formatShortcut(shortcut: Shortcut, mac = isMacPlatform()): string {
  const key = keyLabel(shortcut.code, mac);
  if (mac) return `${shortcut.ctrl ? '⌃' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.mod ? '⌘' : ''}${key}`;
  const parts: string[] = [];
  if (shortcut.mod || shortcut.ctrl) parts.push('Ctrl');
  if (shortcut.shift) parts.push('Shift');
  if (shortcut.alt) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

export type KeyDispatch = {
  /** First refusal (the active tool, an open editor): return true when the key was used. */
  before?(event: KeyboardEvent): boolean | void;
  context(): CommandContext;
  mac?: boolean;
};

/** Handles one window keydown: the tool first, then the command registry. Returns whether the key was
 *  used (its default is then prevented). */
export function handleKeyDown(event: KeyboardEvent, dispatch: KeyDispatch): boolean {
  if (event.defaultPrevented || event.isComposing || (isTypingTarget(event.target) && !handedToDocument(event)) || pressesFocusedControl(event)) return false;
  if (dispatch.before?.(event)) {
    event.preventDefault();
    return true;
  }
  let ctx: CommandContext | null = null;
  const context = () => (ctx ??= dispatch.context());
  const command = findByShortcut(event, dispatch.mac ?? isMacPlatform(), candidate => isEnabled(candidate, context()));
  if (!command || command.clipboardEvent) return false;
  // Browser shortcuts the command shadows (⌘D bookmarks, ⌘G find) stay shadowed even when it cannot run.
  event.preventDefault();
  if (event.repeat && !command.repeat) return true;
  if (isEnabled(command, context())) void command.run(context());
  return true;
}
